import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { LoyaltyPointsService } from '../loyalty-program/services/loyalty-points.service';
import { ShopifyService } from './shopify.service';
import type {
  ShopifyIssuedDiscountDto,
  ShopifyRedemptionDto,
} from './shopify.dto';

@Injectable()
export class ShopifyRedemptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shops: ShopifyService,
    private readonly points: LoyaltyPointsService,
  ) {}

  async reserve(input: ShopifyRedemptionDto, idempotencyKey: string) {
    if (!input.kind)
      throw new BadRequestException('Redemption kind is required');
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new BadRequestException('Idempotency-Key is required');
    const { installation, link } = await this.shops.linked(input);
    const version = await this.prisma.loyaltyProgram.findUnique({
      where: { brandId: installation.brandId },
      include: { currentVersion: true },
    });
    if (!version?.currentVersion || version.status !== 'ACTIVE')
      throw new BadRequestException('Loyalty program is not active');
    const reward =
      input.kind === 'PRODUCT' && input.rewardProductId
        ? await this.prisma.shopifyRewardProduct.findFirst({
            where: {
              id: input.rewardProductId,
              installationId: installation.id,
              enabled: true,
            },
          })
        : null;
    if (input.kind === 'PRODUCT' && !reward)
      throw new NotFoundException('Product reward not found');
    if (
      input.kind === 'ORDER' &&
      version.currentVersion.redemptionType !== 'PARTIAL'
    )
      throw new BadRequestException(
        'Order discounts require partial redemption rules',
      );
    if (input.kind === 'ORDER' && Number(version.currentVersion.maximumBillPercentage ?? 0) <= 0)
      throw new BadRequestException('A positive bill percentage cap is required');
    const requestedPoints = reward ? Number(reward.pointsCost) : input.points;
    if (!requestedPoints || requestedPoints <= 0)
      throw new BadRequestException('Points must be positive');
    if (
      input.kind === 'ORDER' &&
      (!input.cartSubtotal || input.cartSubtotal <= 0)
    )
      throw new BadRequestException('Cart subtotal is required');
    const externalRedemptionId = createHash('sha256')
      .update(`${installation.id}:${input.customerId}:${idempotencyKey}`)
      .digest('hex');
    const existing = await this.prisma.pointRedemption.findFirst({
      where: {
        provider: 'SHOPIFY',
        storeId: installation.storeId,
        externalRedemptionId,
      },
    });
    if (existing) {
      const discount = await this.prisma.shopifyDiscountRedemption.findUnique({
        where: { pointRedemptionId: existing.id },
      });
      if (!discount)
        throw new ConflictException('Redemption is being prepared');
      if (discount.status === 'FAILED' || discount.status === 'EXPIRED' ||
          existing.status !== 'RESERVED' || discount.expiresAt <= new Date())
        throw new ConflictException('Redemption is no longer available');
      return this.instructions(existing, discount);
    }
    const redemption = await this.points.reserve({
      appAuthorized: true,
      storeId: installation.storeId,
      customerBrandId: link.customerBrandId,
      provider: 'SHOPIFY',
      externalRedemptionId,
      requestedPoints,
      invoiceAmount: input.cartSubtotal ?? 0,
      shopifyVariantId: reward?.variantId,
      shopifyPointsCost: reward ? Number(reward.pointsCost) : undefined,
    });
    const reservedVersion = await this.prisma.loyaltyProgramVersion.findUniqueOrThrow({ where: { id: redemption.programVersionId } });
    const cap = Number(reservedVersion.maximumBillPercentage ?? 0);
    if (input.kind === 'ORDER' && cap <= 0) throw new BadRequestException('A positive bill percentage cap is required');
    const minimumSubtotal = reward ? new Prisma.Decimal(0) : new Prisma.Decimal(redemption.monetaryValue).times(100).div(cap).toDecimalPlaces(2, Prisma.Decimal.ROUND_CEIL);
    const discount = await this.prisma.shopifyDiscountRedemption.upsert({
      where: { pointRedemptionId: redemption.id }, update: {}, create: {
        installationId: installation.id,
        pointRedemptionId: redemption.id,
        minimumSubtotal,
        code: this.newCode(),
        shopifyCustomerId: input.customerId,
        variantId: reward?.variantId,
        expiresAt: redemption.reservedUntil,
      },
    });
    return this.instructions(redemption, discount);
  }

  private instructions(
    redemption: {
      id: string;
      requestedPoints: unknown;
      monetaryValue: unknown;
      reservedUntil: Date;
    },
    discount: {
      status: string;
      code: string | null;
      variantId: string | null;
      expiresAt: Date;
      minimumSubtotal: unknown;
    },
  ) {
    return {
      redemptionId: redemption.id,
      status: discount.status,
      code: discount.code,
      requestedPoints: String(redemption.requestedPoints),
      discountAmount: String(redemption.monetaryValue),
      minimumSubtotal: String(discount.minimumSubtotal),
      variantId: discount.variantId,
      expiresAt: discount.expiresAt,
    };
  }

  async issued(input: ShopifyIssuedDiscountDto) {
    if (!input.redemptionId || !/^[0-9a-f-]{36}$/i.test(input.redemptionId) || !input.discountId || !input.code || !/^[A-Za-z0-9_-]{8,100}$/.test(input.code))
      throw new BadRequestException('Issued discount ID and code are required');
    const installation = await this.shops.installation(input.shopId);
    const discount = await this.prisma.shopifyDiscountRedemption.findFirst({
      where: {
        installationId: installation.id,
        pointRedemptionId: input.redemptionId,
      },
      include: { pointRedemption: true },
    });
    if (!discount) throw new NotFoundException('Redemption not found');
    if (discount.shopifyCustomerId !== input.customerId)
      throw new ConflictException('Redemption customer does not match');
    if (discount.code !== input.code)
      throw new ConflictException('Issued code does not match its reservation');
    if (
      discount.status === 'ACTIVE' &&
      discount.discountId === input.discountId &&
      discount.code === input.code
    )
      return { status: 'ACTIVE', code: input.code };
    if (discount.status !== 'PENDING' || discount.expiresAt <= new Date())
      throw new ConflictException('Redemption is no longer issuable');
    await this.prisma.shopifyDiscountRedemption.update({
      where: { id: discount.id },
      data: {
        status: 'ACTIVE',
        discountId: input.discountId,
        code: input.code,
      },
    });
    return { status: 'ACTIVE', code: input.code };
  }

  async fail(shopId: string, redemptionId: string, customerId: string) {
    if (!redemptionId || !customerId) throw new BadRequestException('Redemption and customer IDs are required');
    const installation = await this.shops.installation(shopId);
    const discount = await this.prisma.shopifyDiscountRedemption.findFirst({
      where: {
        installationId: installation.id,
        pointRedemptionId: redemptionId,
      },
      include: { pointRedemption: true },
    });
    if (!discount) throw new NotFoundException('Redemption not found');
    if (discount.shopifyCustomerId !== customerId) throw new ConflictException('Redemption customer does not match');
    if (discount.status === 'FAILED') return { status: 'FAILED' };
    if (!['PENDING', 'ACTIVE'].includes(discount.status))
      throw new ConflictException('Only unused discounts can fail issuance');
    await this.prisma.$transaction(async (tx) => {
      const released = await tx.pointRedemption.updateMany({
        where: { id: redemptionId, status: 'RESERVED' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (released.count !== 1) throw new ConflictException('Redemption is no longer reserved');
      await tx.shopifyDiscountRedemption.update({
        where: { id: discount.id },
        data: { status: 'FAILED' },
      });
      await tx.pointAllocation.updateMany({
        where: { redemptionId, status: 'RESERVED' },
        data: { status: 'RELEASED' },
      });
      if (discount.pointRedemption.posBenefitReservationId)
        await tx.posBenefitReservation.update({
          where: { id: discount.pointRedemption.posBenefitReservationId },
          data: { status: 'RELEASED', releasedAt: new Date() },
        });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { status: 'FAILED' };
  }

  newCode() {
    return `PL${randomBytes(18).toString('hex').toUpperCase()}`;
  }
}
