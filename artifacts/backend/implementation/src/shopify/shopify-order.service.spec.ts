import { BadRequestException } from '@nestjs/common';
import { ShopifyOrderService } from './shopify-order.service';

const snapshot = {
  orderId: 'gid://shopify/Order/123',
  customerId: '456',
  paid: true,
  fullyFulfilled: false,
  cancelled: false,
  currency: 'INR',
  merchandiseAfterDiscounts: '100.00',
  refundedMerchandise: '0.00',
  discountCodes: [],
};

describe('ShopifyOrderService', () => {
  const installation = { id: 'installation', storeId: 'store', shopId: 'shop' };
  const prisma = {
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    purchase: { create: jest.fn(), update: jest.fn() },
    posWebhookEvent: { create: jest.fn() },
    pointRedemption: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    shopifyDiscountRedemption: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    shopifyCustomerPrivacy: { findUnique: jest.fn() },
    store: { findUniqueOrThrow: jest.fn() },
    shopifyOrder: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    shopifyCustomerLink: { findUnique: jest.fn() },
    shopifyWebhookReceipt: { findUnique: jest.fn() },
  };
  const shops = { installation: jest.fn() };
  const points = { awardPurchasePoints: jest.fn(), confirmForOrder: jest.fn(), reverseConfirmedRedemptions: jest.fn(), releaseExpiredReservations: jest.fn() };
  const milestones = { enqueuePurchase: jest.fn(), handleCancellation: jest.fn() };
  const service = new ShopifyOrderService(prisma as never, shops as never, points as never, milestones as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    prisma.shopifyOrder.findUnique.mockResolvedValue(null);
    prisma.shopifyCustomerPrivacy.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.shopifyDiscountRedemption.findMany.mockResolvedValue([]);
    prisma.shopifyDiscountRedemption.findFirst.mockResolvedValue(null);
    prisma.shopifyCustomerLink.findUnique.mockResolvedValue(null);
    prisma.posWebhookEvent.create.mockResolvedValue({ id: 'event' });
    prisma.purchase.create.mockResolvedValue({ id: 'purchase' });
    shops.installation.mockResolvedValue(installation);
    prisma.store.findUniqueOrThrow.mockResolvedValue({ currency: 'INR' });
    prisma.shopifyOrder.upsert.mockResolvedValue({ id: 'order', purchaseId: null });
  });

  it('records a partially fulfilled paid order without awarding points', async () => {
    await service.syncOrder('shop', snapshot);
    expect(prisma.shopifyOrder.upsert).toHaveBeenCalledTimes(1);
    expect(points.awardPurchasePoints).not.toHaveBeenCalled();
    expect(points.confirmForOrder).not.toHaveBeenCalled();
  });

  it('does not award an unlinked customer on full fulfillment', async () => {
    prisma.shopifyCustomerLink.findUnique.mockResolvedValue(null);
    await service.syncOrder('shop', { ...snapshot, fullyFulfilled: true });
    expect(prisma.shopifyCustomerLink.findUnique).toHaveBeenCalled();
    expect(points.awardPurchasePoints).not.toHaveBeenCalled();
  });

  it('rejects a checkout currency mismatch before recording an order', async () => {
    await expect(service.syncOrder('shop', { ...snapshot, currency: 'USD' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.shopifyOrder.upsert).not.toHaveBeenCalled();
  });

  it('does not reprocess an acknowledged webhook', async () => {
    prisma.shopifyWebhookReceipt.findUnique.mockResolvedValue({ processedAt: new Date() });
    await expect(service.accept('shop', 'webhook-1', 'orders/updated', snapshot))
      .resolves.toMatchObject({ duplicate: true });
    expect(prisma.shopifyOrder.upsert).not.toHaveBeenCalled();
  });

  it('ignores stale events before changing the recorded order', async () => {
    prisma.shopifyOrder.findUnique.mockResolvedValue({ sourceUpdatedAt: new Date('2026-11-18T12:00:00Z') });
    await service.syncOrder('shop', { ...snapshot, sourceUpdatedAt: '2026-11-18T11:00:00Z' });
    expect(prisma.shopifyOrder.upsert).not.toHaveBeenCalled();
  });
  it('blocks replay of redacted customer purchases', async () => {
    prisma.shopifyCustomerPrivacy.findUnique.mockResolvedValue({ reconsentedAt: null });
    await expect(service.syncOrder('shop', snapshot)).resolves.toEqual({ ignored: 'CUSTOMER_REDACTED' });
    expect(prisma.shopifyOrder.upsert).not.toHaveBeenCalled();
  });
  it('confirms payment against a purchase while withholding earning until full fulfillment', async () => {
    prisma.shopifyCustomerLink.findUnique.mockResolvedValue({ customerBrandId: 'member' });
    prisma.shopifyDiscountRedemption.findFirst.mockResolvedValue({ id: 'discount', pointRedemptionId: 'redemption' });
    await service.syncOrder('shop', { ...snapshot, discountCodes: ['REWARD'], merchandiseTax: '18.00' });
    expect(points.confirmForOrder).toHaveBeenCalledWith('store', snapshot.orderId, 'purchase', 'SHOPIFY', undefined, 'redemption');
    expect(prisma.purchase.create.mock.calls[0][0].data.eligibleTaxAmount.toString()).toBe('18');
    expect(prisma.purchase.update.mock.calls[0][0].data.loyaltyEligibilitySuppressed).toBe(true);
    expect(points.awardPurchasePoints).not.toHaveBeenCalled();
    expect(milestones.enqueuePurchase).not.toHaveBeenCalled();
  });
  it('awards and evaluates milestones only after payment plus full fulfillment', async () => {
    prisma.shopifyCustomerLink.findUnique.mockResolvedValue({ customerBrandId: 'member' });
    await service.syncOrder('shop', { ...snapshot, fullyFulfilled: true });
    expect(points.awardPurchasePoints).toHaveBeenCalledWith('purchase');
    expect(milestones.enqueuePurchase).toHaveBeenCalledWith('purchase');
    expect(prisma.purchase.update.mock.calls[0][0].data.loyaltyEligibilitySuppressed).toBe(false);
  });
  it('reverses a paid cancellation before fulfillment', async () => {
    prisma.shopifyOrder.upsert.mockResolvedValue({ id: 'order', purchaseId: 'early-purchase' });
    await service.syncOrder('shop', { ...snapshot, cancelled: true });
    expect(points.reverseConfirmedRedemptions).toHaveBeenCalledWith('early-purchase');
    expect(milestones.handleCancellation).toHaveBeenCalledWith('early-purchase');
    expect(points.awardPurchasePoints).not.toHaveBeenCalled();
  });
  it('does not refund points merely because a free reward order totals zero', async () => {
    prisma.shopifyCustomerLink.findUnique.mockResolvedValue({ customerBrandId: 'member' });
    await service.syncOrder('shop', { ...snapshot, merchandiseAfterDiscounts: '0.00', fullyFulfilled: true });
    expect(points.reverseConfirmedRedemptions).not.toHaveBeenCalled();
  });
});
