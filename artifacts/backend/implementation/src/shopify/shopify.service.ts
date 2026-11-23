import { privacyHash } from './shopify-signature';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConsumerOtpService } from '../consumer/services/consumer-otp.service';
import { LoyaltyPointsService } from '../loyalty-program/services/loyalty-points.service';
import { OtpPurpose } from '../generated/prisma/enums';
import type {
  ConnectShopDto,
  ShopifyIdentityDto,
  ShopifyRewardConfigDto,
} from './shopify.dto';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class ShopifyService {
  constructor(
    readonly prisma: PrismaService,
    private readonly otp: ConsumerOtpService,
    private readonly points: LoyaltyPointsService,
  ) {}

  async createConnectionToken(brandId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, brandId, deletedAt: null },
    });
    if (!store) throw new NotFoundException('Store not found in brand');
    if (
      await this.prisma.shopifyInstallation.findFirst({
        where: { storeId, status: 'ACTIVE' },
      })
    )
      throw new ConflictException('Store already has a Shopify connection');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await this.prisma.shopifyConnectionToken.create({
      data: { tokenHash: hash(token), brandId, storeId, expiresAt },
    });
    return { token, expiresAt };
  }

  async connect(input: ConnectShopDto) {
    const allowed = (process.env.SHOPIFY_ALLOWED_SHOPS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(input.shopDomain.toLowerCase()))
      throw new ForbiddenException(
        'Shop is not in the configured Plus organization allowlist',
      );
    return this.prisma.$transaction(async (tx) => {
      const token = await tx.shopifyConnectionToken.findUnique({
        where: { tokenHash: hash(input.token) },
      });
      if (!token || token.usedAt || token.expiresAt <= new Date())
        throw new BadRequestException('Connection token is invalid or expired');
      if (!process.env.SHOPIFY_BRAND_ID ||
        token.brandId !== process.env.SHOPIFY_BRAND_ID)
        throw new ForbiddenException(
          'Store does not belong to the configured Shopify brand',
        );
      const store = await tx.store.findFirst({
        where: { id: token.storeId, brandId: token.brandId, deletedAt: null },
        include: {
          brand: {
            include: { loyaltyProgram: { include: { currentVersion: true } } },
          },
        },
      });
      if (!store) throw new NotFoundException('Store not found');
      if (
        store.currency !== input.currency ||
        store.brand.loyaltyProgram?.currentVersion?.currency !== input.currency
      )
        throw new BadRequestException('Shop and loyalty currencies must match');
      const previous = await tx.shopifyInstallation.findFirst({
        where: {
          OR: [
            { shopId: input.shopId },
            { shopDomain: input.shopDomain },
            { storeId: store.id },
          ],
        },
      });
      if (
        previous &&
        (previous.status !== 'UNINSTALLED' ||
          previous.shopId !== input.shopId ||
          previous.storeId !== store.id)
      )
        throw new ConflictException('Shop or store is already connected');
      if (previous) {
        const installation = await tx.shopifyInstallation.update({
          where: { id: previous.id },
          data: {
            status: 'ACTIVE',
            uninstalledAt: null,
            installedAt: new Date(),
          },
        });
        await tx.shopifyConnectionToken.update({
          where: { id: token.id },
          data: { usedAt: new Date() },
        });
        return {
          installationId: installation.id,
          brandId: token.brandId,
          storeId: store.id,
          status: installation.status,
        };
      }
      const client = await tx.consumerClient.create({
        data: {
          name: `Shopify ${input.shopDomain}`,
          accessMode: 'BRAND',
          brandId: token.brandId,
        },
      });
      const installation = await tx.shopifyInstallation.create({
        data: {
          shopId: input.shopId,
          shopDomain: input.shopDomain.toLowerCase(),
          brandId: token.brandId,
          storeId: store.id,
          consumerClientId: client.id,
        },
      });
      await tx.shopifyConnectionToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });
      return {
        installationId: installation.id,
        brandId: token.brandId,
        storeId: store.id,
        status: installation.status,
      };
    });
  }

  async installation(shopId: string) {
    const installation = await this.prisma.shopifyInstallation.findUnique({
      where: { shopId },
    });
    if (!installation || installation.status !== 'ACTIVE')
      throw new ForbiddenException('Shop is not connected');
    return installation;
  }

  async linked(identity: ShopifyIdentityDto) {
    const installation = await this.installation(identity.shopId);
    const link = await this.prisma.shopifyCustomerLink.findUnique({
      where: {
        installationId_shopifyCustomerId: {
          installationId: installation.id,
          shopifyCustomerId: identity.customerId,
        },
      },
      include: { customerBrand: true },
    });
    if (!link || link.customerBrand.deletedAt || link.customerBrand.blockedAt)
      throw new ForbiddenException(
        'Customer must link an active loyalty account',
      );
    return { installation, link };
  }

  async sendOtp(
    shopId: string,
    customerId: string,
    countryCode: string,
    phoneNumber: string,
  ) {
    const installation = await this.installation(shopId);
    const challenge = await this.otp.issue({
      purpose: OtpPurpose.LOGIN,
      consumerClientId: installation.consumerClientId,
      brandId: installation.brandId,
      countryCode,
      number: phoneNumber,
      deviceId: `shopify:${shopId}:${customerId}`,
    });
    await this.prisma.otpChallenge.update({
      where: { id: challenge.challengeId },
      data: { sessionBinding: hash(`${shopId}:${customerId}`) },
    });
    return challenge;
  }

  async verifyOtp(
    shopId: string,
    customerId: string,
    challengeId: string,
    code: string,
  ) {
    const installation = await this.installation(shopId);
    const privacy = await this.prisma.shopifyCustomerPrivacy.findUnique({ where: { id: privacyHash(shopId, customerId) } });
    if (privacy && !privacy.reconsentedAt) throw new ForbiddenException('Join again and accept the current terms before linking');
    const pending = await this.prisma.otpChallenge.findUnique({
      where: { id: challengeId },
      select: { sessionBinding: true },
    });
    if (pending?.sessionBinding !== hash(`${shopId}:${customerId}`))
      throw new ForbiddenException('OTP challenge belongs to another customer');
    const challenge = await this.otp.verify(
      challengeId,
      code,
      installation.consumerClientId,
      OtpPurpose.LOGIN,
      true,
    );
    if (
      challenge.brandId !== installation.brandId ||
      !challenge.phoneCountryCode ||
      !challenge.phoneNumber
    )
      throw new ForbiddenException(
        'OTP challenge does not belong to this brand',
      );
    const customer = await this.prisma.customerBrand.findFirst({
      where: {
        brandId: installation.brandId,
        phoneCountryCode: challenge.phoneCountryCode,
        phoneNumber: challenge.phoneNumber,
        deletedAt: null,
        blockedAt: null,
      },
    });
    if (!customer)
      throw new NotFoundException(
        'No active loyalty account matches this phone',
      );
    const existing = await this.prisma.shopifyCustomerLink.findUnique({
      where: {
        installationId_shopifyCustomerId: {
          installationId: installation.id,
          shopifyCustomerId: customerId,
        },
      },
    });
    if (existing && existing.customerBrandId !== customer.id)
      throw new ConflictException(
        'Shopify customer is linked to another loyalty account',
      );
    if (!existing)
      await this.prisma.shopifyCustomerLink.create({
        data: {
          installationId: installation.id,
          shopifyCustomerId: customerId,
          customerBrandId: customer.id,
        },
      });
    return { linked: true, customerBrandId: customer.id };
  }

  async balance(identity: ShopifyIdentityDto) {
    const { link } = await this.linked(identity);
    return this.points.walletSummary(link.customerBrandId);
  }

  async rewards(shopId: string) {
    const installation = await this.installation(shopId);
    const products = await this.prisma.shopifyRewardProduct.findMany({
      where: { installationId: installation.id, enabled: true },
      select: { id: true, variantId: true, title: true, pointsCost: true },
    });
    const program = await this.prisma.loyaltyProgram.findUnique({
      where: { brandId: installation.brandId },
      include: { currentVersion: true },
    });
    return {
      products,
      redemptionType: program?.currentVersion?.redemptionType ?? null,
      minimumPoints: program?.currentVersion?.minimumRedemptionPoints ?? null,
      maximumPoints: program?.currentVersion?.maximumRedemptionPoints ?? null,
    };
  }

  async adminRewards(installationId: string) {
    return { products: await this.prisma.shopifyRewardProduct.findMany({ where: { installationId }, orderBy: { createdAt: 'asc' } }) };
  }
  async configureReward(input: ShopifyRewardConfigDto) {
    const installation = await this.installation(input.shopId);
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(input.variantId))
      throw new BadRequestException('Shopify variant GID is invalid');
    const reward = await this.prisma.shopifyRewardProduct.upsert({
      where: {
        installationId_variantId: {
          installationId: installation.id,
          variantId: input.variantId,
        },
      },
      create: {
        installationId: installation.id,
        variantId: input.variantId,
        title: input.title,
        pointsCost: input.pointsCost,
        enabled: input.enabled ?? true,
      },
      update: {
        title: input.title,
        pointsCost: input.pointsCost,
        enabled: input.enabled ?? true,
      },
    });
    return {
      id: reward.id,
      variantId: reward.variantId,
      title: reward.title,
      pointsCost: reward.pointsCost,
      enabled: reward.enabled,
    };
  }
}
