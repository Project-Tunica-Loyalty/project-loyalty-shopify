import { recordDetectionWork } from '../customer/suspicious/suspicious-detection-work';
import { LoyaltyMilestoneService } from '../loyalty-program/services/loyalty-milestone.service';
import { privacyHash } from './shopify-signature';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { LoyaltyPointsService } from '../loyalty-program/services/loyalty-points.service';
import { ShopifyService } from './shopify.service';

type OrderSnapshot = {
  orderId: string;
  customerId?: string;
  paid: boolean;
  fullyFulfilled: boolean;
  cancelled: boolean;
  currency: string;
  merchandiseAfterDiscounts: string;
  refundedMerchandise: string;
  merchandiseTax?: string;
  refundedMerchandiseTax?: string;
  discountedItemRefunded?: boolean;
  refundedVariantIds?: string[];
  discountCodes?: string[];
  occurredAt?: string;
  sourceUpdatedAt?: string;
};

@Injectable()
export class ShopifyOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shops: ShopifyService,
    private readonly points: LoyaltyPointsService,
    private readonly milestones: LoyaltyMilestoneService,
  ) {}

  async accept(
    shopId: string,
    webhookId: string,
    topic: string,
    payload: Record<string, unknown>,
  ) {
    const installation = topic === 'app/uninstalled'
      ? await this.prisma.shopifyInstallation.findUnique({ where: { shopId } })
      : await this.shops.installation(shopId);
    if (!installation) throw new BadRequestException('Unknown Shopify shop');
    const existing = await this.prisma.shopifyWebhookReceipt.findUnique({
      where: { webhookId },
    });
    if (existing?.processedAt) return { duplicate: true,
      discountIds: topic === 'app/uninstalled'
        ? (await this.prisma.shopifyDiscountRedemption.findMany({
            where: { installationId: installation.id, discountId: { not: null } },
            select: { discountId: true },
          })).map((row) => row.discountId).filter(Boolean)
        : undefined,
    };
    const receipt =
      existing ??
      (await this.prisma.shopifyWebhookReceipt.create({
        data: {
          installationId: installation.id,
          webhookId,
          topic,
          payload: payload as Prisma.InputJsonObject,
        },
      }));
    try {
      if (topic === 'app/uninstalled') {
        const discounts = await this.prisma.shopifyDiscountRedemption.findMany({
          where: { installationId: installation.id, status: { in: ['PENDING', 'ACTIVE'] } },
          select: { pointRedemptionId: true, discountId: true },
        });
        await this.prisma.pointRedemption.updateMany({
          where: { id: { in: discounts.map((row) => row.pointRedemptionId) }, status: 'RESERVED' },
          data: { reservedUntil: new Date() },
        });
        await this.points.releaseExpiredReservations();
        await this.prisma.shopifyDiscountRedemption.updateMany({
          where: { installationId: installation.id, status: { in: ['PENDING', 'ACTIVE'] } },
          data: { status: 'EXPIRED' },
        });
        await this.prisma.shopifyInstallation.update({
          where: { id: installation.id },
          data: { status: 'UNINSTALLED', uninstalledAt: new Date() },
        });
      } else if (topic.startsWith('orders/') || topic.startsWith('refunds/')) {
        await this.syncOrder(shopId, payload as OrderSnapshot);
      } else throw new BadRequestException('Unsupported Shopify topic');
      await this.prisma.shopifyWebhookReceipt.update({
        where: { id: receipt.id },
        data: { processedAt: new Date() },
      });
      return { accepted: true,
        discountIds: topic === 'app/uninstalled'
          ? (await this.prisma.shopifyDiscountRedemption.findMany({
              where: { installationId: installation.id, discountId: { not: null } },
              select: { discountId: true },
            })).map((row) => row.discountId).filter(Boolean)
          : undefined,
      };
    } catch (error) {
      await this.prisma.shopifyWebhookReceipt.update({
        where: { id: receipt.id },
        data: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }

  async syncOrder(shopId: string, snapshot: OrderSnapshot) {
    return this.prisma.$transaction(async lock => {
      await lock.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${shopId + ':' + snapshot.orderId}, 0))`;
      return this.syncOrderLocked(shopId, snapshot);
    }, { timeout: 30000 });
  }

  private async syncOrderLocked(shopId: string, snapshot: OrderSnapshot) {
    const installation = await this.shops.installation(shopId);
    if (
      !snapshot.orderId ||
      !snapshot.currency ||
      ['paid', 'fullyFulfilled', 'cancelled'].some(key => typeof snapshot[key] !== 'boolean') ||
      [snapshot.merchandiseTax ?? '0', snapshot.refundedMerchandiseTax ?? '0'].some(value => !/^\d+(\.\d{1,2})?$/.test(value)) ||
      (snapshot.occurredAt && !Number.isFinite(new Date(snapshot.occurredAt).getTime())) ||
      !/^\d+(\.\d{1,2})?$/.test(snapshot.merchandiseAfterDiscounts) ||
      !/^\d+(\.\d{1,2})?$/.test(snapshot.refundedMerchandise)
    )
      throw new BadRequestException('Invalid order snapshot');
    const store = await this.prisma.store.findUniqueOrThrow({
      where: { id: installation.storeId },
    });
    if (snapshot.currency !== store.currency)
      throw new BadRequestException('Order currency does not match store');
    const sourceTime = snapshot.sourceUpdatedAt ? new Date(snapshot.sourceUpdatedAt) : null;
    if (sourceTime && !Number.isFinite(sourceTime.getTime())) throw new BadRequestException('Invalid source update time');
    const previous = await this.prisma.shopifyOrder.findUnique({ where: { installationId_shopifyOrderId: { installationId: installation.id, shopifyOrderId: snapshot.orderId } } });
    if (previous?.sourceUpdatedAt && (!sourceTime || previous.sourceUpdatedAt > sourceTime)) return previous;
    if (snapshot.customerId) {
      const privacy = await this.prisma.shopifyCustomerPrivacy.findUnique({ where: { id: privacyHash(shopId, snapshot.customerId) } });
      if (privacy && (!privacy.reconsentedAt || !snapshot.occurredAt || new Date(snapshot.occurredAt) < privacy.reconsentedAt)) return { ignored: 'CUSTOMER_REDACTED' };
    }
    const gross = new Prisma.Decimal(snapshot.merchandiseAfterDiscounts);
    const refund = new Prisma.Decimal(snapshot.refundedMerchandise);
    const net = Prisma.Decimal.max(0, gross.minus(refund));
    const tax = new Prisma.Decimal(snapshot.merchandiseTax ?? 0);
    const netTax = Prisma.Decimal.max(0, tax.minus(snapshot.refundedMerchandiseTax ?? 0));
    const order = await this.prisma.shopifyOrder.upsert({
      where: {
        installationId_shopifyOrderId: {
          installationId: installation.id,
          shopifyOrderId: snapshot.orderId,
        },
      },
      create: {
        installationId: installation.id,
        shopifyOrderId: snapshot.orderId,
        shopifyCustomerId: snapshot.customerId,
        sourceUpdatedAt: sourceTime,
        paid: snapshot.paid,
        fullyFulfilled: snapshot.fullyFulfilled,
        cancelled: snapshot.cancelled,
        currency: snapshot.currency,
        earningAmount: net,
        refundedAmount: refund,
        occurredAt: snapshot.occurredAt ? new Date(snapshot.occurredAt) : null,
      },
      update: {
        shopifyCustomerId: snapshot.customerId,
        paid: snapshot.paid,
        fullyFulfilled: snapshot.fullyFulfilled,
        cancelled: snapshot.cancelled,
        earningAmount: net,
        refundedAmount: refund,
        sourceUpdatedAt: sourceTime,
        lastSyncedAt: new Date(),
      },
    });
    const link = snapshot.customerId ? await this.prisma.shopifyCustomerLink.findUnique({
      where: { installationId_shopifyCustomerId: { installationId: installation.id, shopifyCustomerId: snapshot.customerId } },
    }) : null;
    let purchaseId = order.purchaseId;
    // Payment must link redemptions to a purchase even while earning is held for fulfillment.
    if (!purchaseId && link && snapshot.paid && (snapshot.fullyFulfilled || snapshot.discountCodes?.length)) {
      const purchase = await this.prisma.$transaction(async tx => {
        const event = await tx.posWebhookEvent.create({ data: { provider: 'SHOPIFY', eventType: 'ORDER',
          externalEventId: installation.id + ':' + snapshot.orderId, webhookJson: snapshot as unknown as Prisma.InputJsonObject } });
        const created = await tx.purchase.create({ data: { storeId: installation.storeId, customerBrandId: link.customerBrandId,
          posWebhookEventId: event.id, status: 'BOUGHT', posProvider: 'SHOPIFY', externalOrderId: snapshot.orderId,
          totalBillAmountWithoutTax: gross, finalAmount: gross.plus(tax), customerPaidAmount: net.plus(netTax),
          eligibleEarningAmount: gross, eligibleTaxAmount: tax, taxAmount: tax,
          loyaltyEligibilitySuppressed: true, currency: snapshot.currency, occurredAt: order.occurredAt } });
        await tx.shopifyOrder.update({ where: { id: order.id }, data: { purchaseId: created.id } });
        return created;
      });
      purchaseId = purchase.id;
    }
    if (snapshot.cancelled) {
      const claimed = await this.prisma.shopifyDiscountRedemption.findMany({
        where: { installationId: installation.id, usedOrderId: snapshot.orderId },
        select: { pointRedemptionId: true },
      });
      if (claimed.length) {
        await this.prisma.pointRedemption.updateMany({
          where: { id: { in: claimed.map((row) => row.pointRedemptionId) }, status: 'RESERVED' },
          data: { reservedUntil: new Date() },
        });
        await this.points.releaseExpiredReservations();
      }
    }
    if (snapshot.customerId) {
      for (const code of snapshot.discountCodes ?? []) {
        const discount = await this.prisma.shopifyDiscountRedemption.findFirst({
          where: {
            installationId: installation.id,
            code,
            status: { in: ['ACTIVE', 'USED'] },
            shopifyCustomerId: snapshot.customerId,
            OR: [{ usedOrderId: null }, { usedOrderId: snapshot.orderId }],
          },
        });
        if (!discount) continue;
        if (snapshot.cancelled && !snapshot.paid) {
          await this.prisma.pointRedemption.updateMany({ where: { id: discount.pointRedemptionId, status: 'RESERVED' }, data: { reservedUntil: new Date() } });
          await this.points.releaseExpiredReservations();
          await this.prisma.shopifyDiscountRedemption.update({ where: { id: discount.id }, data: { status: 'EXPIRED', usedOrderId: snapshot.orderId } });
          continue;
        }
        if (!snapshot.paid) {
          const holdUntil = new Date(Date.now() + 7 * 24 * 60 * 60_000);
          await this.prisma.pointRedemption.updateMany({
            where: { id: discount.pointRedemptionId, status: 'RESERVED' },
            data: { reservedUntil: holdUntil },
          });
          const redemption = await this.prisma.pointRedemption.findUnique({
            where: { id: discount.pointRedemptionId },
            select: { posBenefitReservationId: true },
          });
          if (redemption?.posBenefitReservationId)
            await this.prisma.posBenefitReservation.update({
              where: { id: redemption.posBenefitReservationId },
              data: { reservedUntil: holdUntil },
            });
          await this.prisma.shopifyDiscountRedemption.update({
            where: { id: discount.id },
            data: { status: 'USED', usedOrderId: snapshot.orderId },
          });
          continue;
        }
        await this.prisma.pointRedemption.update({
          where: { id: discount.pointRedemptionId },
          data: { externalOrderId: snapshot.orderId },
        });
        await this.points.confirmForOrder(
          installation.storeId,
          snapshot.orderId,
          purchaseId ?? undefined,
          'SHOPIFY',
          undefined,
          discount.pointRedemptionId,
        );
        await this.prisma.shopifyDiscountRedemption.update({
          where: { id: discount.id },
          data: { status: 'USED', usedOrderId: snapshot.orderId },
        });
      }
    }
    const refundedReward = (snapshot.refundedVariantIds?.length && snapshot.discountCodes?.length)
      ? await this.prisma.shopifyDiscountRedemption.findFirst({
          where: {
            installationId: installation.id,
            usedOrderId: snapshot.orderId,
            code: { in: snapshot.discountCodes },
            variantId: { in: snapshot.refundedVariantIds },
          },
        })
      : null;
    const reverseReward = Boolean(snapshot.cancelled || (refund.gt(0) && net.isZero()) || snapshot.discountedItemRefunded || refundedReward);
    if (purchaseId) {
      await this.prisma.purchase.update({ where: { id: purchaseId }, data: {
        status: snapshot.cancelled ? 'CANCELLED' : 'BOUGHT', customerPaidAmount: net.plus(netTax),
        loyaltyEligibilitySuppressed: !snapshot.paid || !snapshot.fullyFulfilled || snapshot.cancelled || (refund.gt(0) && net.isZero()),
      } });
      if (snapshot.cancelled || refund.gt(0)) await this.reconcileGrant(purchaseId, net, gross, snapshot.cancelled, netTax, tax);
      if (reverseReward) await this.points.reverseConfirmedRedemptions(purchaseId);
      if (snapshot.cancelled || (refund.gt(0) && net.isZero())) await this.milestones.handleCancellation(purchaseId);
    }
    if (!snapshot.paid || !snapshot.fullyFulfilled || !snapshot.customerId || snapshot.cancelled || !link || !purchaseId) return order;
    if (net.gt(0)) await this.points.awardPurchasePoints(purchaseId);
    await this.reconcileGrant(purchaseId, net, gross, snapshot.cancelled, netTax, tax);
    if (net.gt(0)) await this.milestones.enqueuePurchase(purchaseId);
    for (const code of snapshot.discountCodes ?? []) {
      const discount = await this.prisma.shopifyDiscountRedemption.findFirst({
        where: {
          installationId: installation.id,
          code,
          usedOrderId: snapshot.orderId,
        },
      });
      if (discount)
        await this.points.confirmForOrder(
          installation.storeId,
          snapshot.orderId,
          purchaseId,
          'SHOPIFY',
          undefined,
          discount.pointRedemptionId,
        );
    }
    if (reverseReward)
      await this.points.reverseConfirmedRedemptions(purchaseId);
    return order;
  }

  private async reconcileGrant(
    purchaseId: string,
    net: Prisma.Decimal,
    gross: Prisma.Decimal,
    cancelled: boolean,
    netTax: Prisma.Decimal,
    grossTax: Prisma.Decimal,
  ) {
    await this.prisma.$transaction(
      async (tx) => {
        const reverseAll = cancelled || (gross.gt(0) && net.isZero());
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "RewardsLedger" WHERE "purchaseId" = ${purchaseId}::uuid AND "eventType" = 'GRANTED' AND ("creationSource" = 'PURCHASE' OR (${reverseAll} AND "creationSource" = 'MILESTONE')) FOR UPDATE`;
        if (!locked.length) return;
        for (const row of locked) {
        const grant = await tx.rewardsLedger.findUniqueOrThrow({
          where: { id: row.id },
          include: { children: true, loyaltyProgramVersion: true },
        });
        const eligibleGross = grant.loyaltyProgramVersion?.givePointsOnTaxValue ? gross.plus(grossTax) : gross;
        const eligibleNet = grant.loyaltyProgramVersion?.givePointsOnTaxValue ? net.plus(netTax) : net;
        const remaining =
          cancelled || eligibleGross.isZero()
            ? new Prisma.Decimal(0)
            : new Prisma.Decimal(grant.points)
                .times(eligibleNet)
                .div(eligibleGross)
                .toDecimalPlaces(2);
        const reversed = grant.children.reduce(
          (sum, row) => sum.plus(new Prisma.Decimal(row.points)),
          new Prisma.Decimal(0),
        );
        const needed = new Prisma.Decimal(grant.points)
          .minus(remaining)
          .plus(reversed);
        if (needed.lte(0)) continue;
        if (grant.customerBrandId) await recordDetectionWork(tx, grant.customerBrandId, grant.id, 'REVERSAL');
        await tx.rewardsLedger.create({
          data: {
            purchaseId,
            customerBrandId: grant.customerBrandId,
            parentId: grant.id,
            points: needed.negated(),
            eventType: 'REVERSED',
            creationSource: 'REVERSAL',
            loyaltyProgramVersionId: grant.loyaltyProgramVersionId,
          },
        });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
