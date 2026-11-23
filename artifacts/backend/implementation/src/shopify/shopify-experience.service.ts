import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConsumerSignupService } from '../consumer/services/consumer-signup.service';
import { ShopifyService } from './shopify.service';
import { CompleteShopifySignupDto, ShopifySignupOtpDto, ShopifySignupVerifyDto } from './shopify.dto';

const binding = (shopId: string, customerId: string) => createHash('sha256').update('shopify-signup:' + shopId + ':' + customerId).digest('hex');
import { privacyHash } from './shopify-signature';

@Injectable()
export class ShopifyExperienceService {
  constructor(private readonly prisma: PrismaService, private readonly shops: ShopifyService, private readonly signup: ConsumerSignupService) {}

  async context(shopId: string, shopDomain: string) {
    const allowed = (process.env.SHOPIFY_ALLOWED_SHOPS || '').split(',').map(value => value.trim().toLowerCase());
    if (!allowed.includes(shopDomain.toLowerCase())) throw new ForbiddenException('Shop is not allowed for this brand app');
    const brandId = process.env.SHOPIFY_BRAND_ID;
    if (!brandId) throw new BadRequestException('SHOPIFY_BRAND_ID is not configured');
    const brand = await this.prisma.brand.findFirstOrThrow({ where: { id: brandId, deletedAt: null, status: 'ACTIVE' }, select: { name: true } });
    const installation = await this.prisma.shopifyInstallation.findUnique({ where: { shopId } });
    if (installation && (installation.brandId !== brandId || installation.shopDomain !== shopDomain.toLowerCase())) throw new ForbiddenException('Shop belongs to a different brand');
    return { brandId, brandName: brand.name, connected: installation?.status === 'ACTIVE', storeId: installation?.storeId ?? null,
      termsUrl: process.env.SHOPIFY_TERMS_URL || null, privacyUrl: process.env.SHOPIFY_PRIVACY_URL || null,
      termsVersion: process.env.SHOPIFY_TERMS_VERSION || 'v1' };
  }

  private async client(shopId: string) {
    const installation = await this.shops.installation(shopId);
    const client = await this.prisma.consumerClient.findUniqueOrThrow({ where: { id: installation.consumerClientId } });
    if (!client.enabled || client.revokedAt || client.brandId !== installation.brandId) throw new ForbiddenException('Loyalty signup is unavailable');
    return { id: client.id, brandId: installation.brandId };
  }

  async send(input: ShopifySignupOtpDto, ip?: string) {
    if (!process.env.SHOPIFY_TERMS_URL || !process.env.SHOPIFY_PRIVACY_URL) throw new BadRequestException('The brand must configure its terms and privacy links before signup');
    const client = await this.client(input.shopId);
    const result = await this.signup.sendOtp(client, { mobile: { countryCode: input.countryCode, number: input.phoneNumber } }, ip, binding(input.shopId, input.customerId));
    return result;
  }

  async verify(input: ShopifySignupVerifyDto) {
    const client = await this.client(input.shopId);
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { id: input.challengeId } });
    if (challenge?.sessionBinding !== binding(input.shopId, input.customerId)) throw new ForbiddenException('Signup challenge belongs to another Shopify customer');
    return this.signup.verifyOtp(client, { challengeId: input.challengeId, otp: input.otp });
  }

  async resend(input: { shopId: string; customerId: string; challengeId: string }, ip?: string) {
    const client = await this.client(input.shopId);
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { id: input.challengeId } });
    if (challenge?.sessionBinding !== binding(input.shopId, input.customerId)) throw new ForbiddenException('Signup challenge belongs to another Shopify customer');
    const result = await this.signup.resendOtp(client, input.challengeId, ip);
    await this.prisma.otpChallenge.update({ where: { id: result.challengeId }, data: { sessionBinding: binding(input.shopId, input.customerId) } });
    return result;
  }

  async complete(input: CompleteShopifySignupDto) {
    const client = await this.client(input.shopId);
    const installation = await this.shops.installation(input.shopId);
    const expectedVersion = process.env.SHOPIFY_TERMS_VERSION || 'v1';
    if (!input.termsAccepted || input.termsVersion !== expectedVersion) throw new BadRequestException('Accept the current brand terms before joining');
    const previous = await this.prisma.shopifyCustomerLink.findUnique({ where: { installationId_shopifyCustomerId: { installationId: installation.id, shopifyCustomerId: input.customerId } } });
    if (previous) return { linked: true, customerBrandId: previous.customerBrandId };
    const result = await this.signup.complete(client, { signupVerificationToken: input.signupVerificationToken, name: input.name,
      consents: [{ type: 'TERMS', accepted: true, documentVersion: expectedVersion },
        { type: 'MARKETING_SMS', accepted: input.marketingAccepted === true, documentVersion: expectedVersion }] },
      { source: 'SHOPIFY', sessionBinding: binding(input.shopId, input.customerId), onComplete: async (tx, membershipId) => {
        await tx.shopifyCustomerLink.create({ data: { installationId: installation.id, shopifyCustomerId: input.customerId, customerBrandId: membershipId } });
        await tx.shopifyCustomerPrivacy.updateMany({ where: { id: privacyHash(input.shopId, input.customerId) }, data: { reconsentedAt: new Date() } });
      } });
    return { linked: true, customerBrandId: result.signup.customerBrandId };
  }

  async expired(shopId: string) {
    const installation = await this.shops.installation(shopId);
    return this.prisma.shopifyDiscountRedemption.findMany({ where: { installationId: installation.id, deactivatedAt: null, discountId: { not: null }, status: { in: ['EXPIRED', 'FAILED'] } }, select: { discountId: true }, take: 100 });
  }
  async deactivated(shopId: string, discountId: string) {
    const installation = await this.shops.installation(shopId);
    return this.prisma.shopifyDiscountRedemption.updateMany({ where: { installationId: installation.id, discountId, status: { in: ['EXPIRED', 'FAILED'] } }, data: { deactivatedAt: new Date() } });
  }
  async privacy(shopDomain: string, topic: string, payload: { customer?: { id?: string | number }; data_request?: { id?: string | number } }) {
    const installation = await this.prisma.shopifyInstallation.findUnique({ where: { shopDomain } });
    if (!installation) return { handled: true };
    const customerId = payload.customer?.id == null ? null : String(payload.customer.id);
    if (topic === 'customers/data_request') {
      if (!customerId) throw new BadRequestException('Customer ID is required');
      const link = await this.prisma.shopifyCustomerLink.findUnique({ where: { installationId_shopifyCustomerId: { installationId: installation.id, shopifyCustomerId: customerId } } });
      const orders = await this.prisma.shopifyOrder.findMany({ where: { installationId: installation.id, shopifyCustomerId: customerId }, select: { shopifyOrderId: true, paid: true, fullyFulfilled: true, cancelled: true, earningAmount: true, refundedAmount: true, currency: true, occurredAt: true } });
      const profile = link ? await this.prisma.customerBrand.findUnique({ where: { id: link.customerBrandId }, select: { name: true, phoneCountryCode: true, phoneNumber: true } }) : null;
      const consents = link ? await this.prisma.customerConsent.findMany({ where: { customerBrandId: link.customerBrandId }, select: { consentType: true, documentVersion: true, accepted: true, capturedAt: true, source: true } }) : [];
      const points = link ? await this.prisma.rewardsLedger.findMany({ where: { customerBrandId: link.customerBrandId }, select: { points: true, eventType: true, creationSource: true, expiresAt: true, createdAt: true } }) : [];
      const redemptions = await this.prisma.shopifyDiscountRedemption.findMany({ where: { installationId: installation.id, shopifyCustomerId: customerId }, select: { status: true, variantId: true, expiresAt: true, usedOrderId: true, pointRedemption: { select: { requestedPoints: true, monetaryValue: true, status: true, confirmedAt: true, reversedAt: true } } } });
      return { customerId, linked: Boolean(link), profile, consents, points, orders, redemptions };
    }
    if (!['customers/redact', 'shop/redact'].includes(topic)) throw new BadRequestException('Unsupported privacy event');
    if (topic === 'customers/redact' && !customerId) throw new BadRequestException('Customer ID is required');
    if (topic === 'shop/redact' && installation.status !== 'UNINSTALLED') throw new ConflictException('Shop must be uninstalled before redaction');
    const customerFilter = customerId ? { shopifyCustomerId: customerId } : {};
    const discountIds = await this.prisma.$transaction(async tx => {
      const identities = customerId ? [{ shopifyCustomerId: customerId }] : await tx.shopifyCustomerLink.findMany({ where: { installationId: installation.id }, select: { shopifyCustomerId: true } });
      for (const identity of identities) await tx.shopifyCustomerPrivacy.upsert({ where: { id: privacyHash(installation.shopId, identity.shopifyCustomerId) }, create: { id: privacyHash(installation.shopId, identity.shopifyCustomerId) }, update: { reconsentedAt: null, redactedAt: new Date() } });
      const purchases = await tx.shopifyOrder.findMany({ where: { installationId: installation.id, ...customerFilter }, select: { purchase: { select: { posWebhookEventId: true } } } });
      await tx.posWebhookEvent.updateMany({ where: { id: { in: purchases.flatMap(row => row.purchase ? [row.purchase.posWebhookEventId] : []) }, provider: 'SHOPIFY' }, data: { webhookJson: {} } });
      const discounts = await tx.shopifyDiscountRedemption.findMany({ where: { installationId: installation.id, ...customerFilter, status: { in: ['PENDING', 'ACTIVE'] } }, select: { pointRedemptionId: true, discountId: true } });
      await tx.pointRedemption.updateMany({ where: { id: { in: discounts.map(row => row.pointRedemptionId) }, status: 'RESERVED' }, data: { reservedUntil: new Date() } });
      await tx.shopifyCustomerLink.deleteMany({ where: { installationId: installation.id, ...customerFilter } });
      await tx.shopifyOrder.updateMany({ where: { installationId: installation.id, ...customerFilter }, data: { shopifyCustomerId: null } });
      await tx.shopifyDiscountRedemption.updateMany({ where: { installationId: installation.id, ...customerFilter }, data: { shopifyCustomerId: 'redacted', usedOrderId: null, code: null, status: 'EXPIRED' } });
      await tx.shopifyWebhookReceipt.updateMany({ where: { installationId: installation.id }, data: { payload: {}, error: null } });
      return discounts.map(row => row.discountId).filter((id): id is string => Boolean(id));
    });
    return { handled: true, discountIds };
  }
}
