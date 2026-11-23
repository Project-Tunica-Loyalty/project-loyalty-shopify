import { Prisma } from '../generated/prisma/client';
import { ShopifyRedemptionService } from './shopify-redemption.service';

describe('Shopify redemption boundaries and recovery', () => {
  const prisma = {
    $transaction: jest.fn(),
    loyaltyProgram: { findUnique: jest.fn() },
    loyaltyProgramVersion: { findUniqueOrThrow: jest.fn() },
    pointRedemption: { findFirst: jest.fn(), updateMany: jest.fn() },
    pointAllocation: { updateMany: jest.fn() },
    shopifyDiscountRedemption: { findUnique: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  };
  const shops = { linked: jest.fn(), installation: jest.fn() };
  const points = { reserve: jest.fn() };
  const service = new ShopifyRedemptionService(prisma as never, shops as never, points as never);
  const input = { shopId: 'shop', customerId: 'customer', kind: 'ORDER' as const, points: 25, cartSubtotal: 100 };
  const reserved = { id: '12345678-1234-1234-1234-123456789abc', programVersionId: 'version', requestedPoints: 25, monetaryValue: new Prisma.Decimal('12.34'), reservedUntil: new Date(Date.now() + 600000), status: 'RESERVED' };
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(fn => fn(prisma));
    shops.linked.mockResolvedValue({ installation: { id: 'installation', storeId: 'store', brandId: 'brand' }, link: { customerBrandId: 'member' } });
    shops.installation.mockResolvedValue({ id: 'installation' });
    prisma.loyaltyProgram.findUnique.mockResolvedValue({ status: 'ACTIVE', currentVersion: { redemptionType: 'PARTIAL', maximumBillPercentage: 20 } });
    prisma.loyaltyProgramVersion.findUniqueOrThrow.mockResolvedValue({ maximumBillPercentage: 20 });
    points.reserve.mockResolvedValue(reserved);
    prisma.shopifyDiscountRedemption.upsert.mockImplementation(({ create }) => create);
    prisma.pointRedemption.updateMany.mockResolvedValue({ count: 1 });
  });

  it('derives a rounded-up checkout minimum from the reserved value and version', async () => {
    const result = await service.reserve(input, 'same-key');
    expect(result.minimumSubtotal).toBe('61.7');
    expect(result.code).toMatch(/^PL[A-F0-9]+$/);
    expect(prisma.loyaltyProgramVersion.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'version' } });
  });
  it('returns the same code on a lost-response retry without reserving twice', async () => {
    prisma.pointRedemption.findFirst.mockResolvedValue(reserved);
    prisma.shopifyDiscountRedemption.findUnique.mockResolvedValue({ status: 'PENDING', code: 'PLSAMECODE', minimumSubtotal: '61.70', expiresAt: reserved.reservedUntil });
    expect((await service.reserve(input, 'same-key')).code).toBe('PLSAMECODE');
    expect(points.reserve).not.toHaveBeenCalled();
  });
  it('rejects invalid percentage rules before holding points', async () => {
    prisma.loyaltyProgram.findUnique.mockResolvedValue({ status: 'ACTIVE', currentVersion: { redemptionType: 'PARTIAL', maximumBillPercentage: 0 } });
    await expect(service.reserve(input, 'key')).rejects.toThrow('positive bill percentage');
    expect(points.reserve).not.toHaveBeenCalled();
  });
  it('refuses another customer releasing a reservation', async () => {
    prisma.shopifyDiscountRedemption.findFirst.mockResolvedValue({ shopifyCustomerId: 'owner', status: 'PENDING' });
    await expect(service.fail('shop', reserved.id, 'attacker')).rejects.toThrow('customer does not match');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('recovers a deactivated code even after an issuance acknowledgement was lost', async () => {
    prisma.shopifyDiscountRedemption.findFirst.mockResolvedValue({ id: 'discount', shopifyCustomerId: 'customer', status: 'ACTIVE', pointRedemption: {} });
    await expect(service.fail('shop', reserved.id, 'customer')).resolves.toEqual({ status: 'FAILED' });
    expect(prisma.pointAllocation.updateMany).toHaveBeenCalledWith({ where: { redemptionId: reserved.id, status: 'RESERVED' }, data: { status: 'RELEASED' } });
  });
  it('does not release a redemption that was already spent', async () => {
    prisma.shopifyDiscountRedemption.findFirst.mockResolvedValue({ id: 'discount', shopifyCustomerId: 'customer', status: 'ACTIVE', pointRedemption: {} });
    prisma.pointRedemption.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.fail('shop', reserved.id, 'customer')).rejects.toThrow('no longer reserved');
    expect(prisma.pointAllocation.updateMany).not.toHaveBeenCalled();
  });
  it('refuses an issued code that differs from its reservation', async () => {
    prisma.shopifyDiscountRedemption.findFirst.mockResolvedValue({ shopifyCustomerId: 'customer', code: 'PLRESERVED' });
    await expect(service.issued({ shopId: 'shop', customerId: 'customer', redemptionId: reserved.id, discountId: 'gid://shopify/DiscountCodeNode/1', code: 'PLDIFFERENT' })).rejects.toThrow('does not match its reservation');
  });
});
