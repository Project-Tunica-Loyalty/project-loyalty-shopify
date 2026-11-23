import { ConsumerSignupService } from './consumer-signup.service';

describe('Shopify signup through shared consumer enrollment', () => {
  const prisma = {
    $transaction: jest.fn(),
    otpChallenge: { findFirst: jest.fn(), updateMany: jest.fn() },
    consumerAccount: { upsert: jest.fn() },
    customerBrand: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    customerConsent: { upsert: jest.fn() },
  };
  const jwt = { verifyAsync: jest.fn() };
  const otp = { normalize: jest.fn() };
  const auth = { createSession: jest.fn() };
  const service = new ConsumerSignupService(prisma as never, jwt as never, otp as never, auth as never, {} as never);
  const client = { id: 'client', brandId: 'brand' };
  const dto = { name: 'New name', signupVerificationToken: 'verified', consents: [{ type: 'TERMS' as const, accepted: true, documentVersion: 'v1' }, { type: 'MARKETING_SMS' as const, accepted: false, documentVersion: 'v1' }] };
  const options = { source: 'SHOPIFY' as const, sessionBinding: 'shop-customer', onComplete: jest.fn() };
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.NODE_ENV = 'test';
    prisma.$transaction.mockImplementation(fn => fn(prisma));
    jwt.verifyAsync.mockResolvedValue({ challengeId: 'challenge', brandId: 'brand', consumerClientId: 'client', normalizedPhone: '+919876543210', tokenUse: 'CUSTOMER_SIGNUP' });
    otp.normalize.mockReturnValue('+919876543210');
    prisma.otpChallenge.findFirst.mockResolvedValue({ id: 'challenge', phoneCountryCode: '+91', phoneNumber: '9876543210' });
    prisma.otpChallenge.updateMany.mockResolvedValue({ count: 1 });
    prisma.consumerAccount.upsert.mockResolvedValue({ id: 'account', status: 'ACTIVE' });
    prisma.customerBrand.findFirst.mockResolvedValue({ id: 'existing-member', name: 'Original name' });
    prisma.customerBrand.create.mockResolvedValue({ id: 'new-member' });
  });
  it('links existing membership without overwriting profile or consent', async () => {
    await expect(service.complete(client, dto, options)).resolves.toMatchObject({ signup: { customerBrandId: 'existing-member' } });
    expect(prisma.customerBrand.create).not.toHaveBeenCalled();
    expect(prisma.customerBrand.update).not.toHaveBeenCalled();
    expect(prisma.customerConsent.upsert.mock.calls[0][0]).toMatchObject({ update: {}, create: { source: 'SHOPIFY', accepted: true } });
    expect(options.onComplete).toHaveBeenCalledWith(prisma, 'existing-member');
    expect(auth.createSession).not.toHaveBeenCalled();
    expect(prisma.otpChallenge.findFirst.mock.calls[0][0].where.sessionBinding).toBe('shop-customer');
  });
  it('creates a member with optional marketing off', async () => {
    prisma.customerBrand.findFirst.mockResolvedValue(null);
    await service.complete(client, dto, options);
    expect(prisma.customerBrand.create.mock.calls[0][0].data).toMatchObject({ brandId: 'brand', notificationConsent: false, name: 'New name' });
  });
  it('rejects blocked members before changing consents or links', async () => {
    prisma.customerBrand.findFirst.mockResolvedValue({ id: 'blocked', blockedAt: new Date() });
    await expect(service.complete(client, dto, options)).rejects.toThrow('blocked');
    expect(options.onComplete).not.toHaveBeenCalled();
    expect(prisma.customerConsent.upsert).not.toHaveBeenCalled();
  });
  it('rejects a verification token for another brand', async () => {
    await expect(service.complete({ ...client, brandId: 'other' }, dto, options)).rejects.toThrow('context does not match');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('does not reuse consumed or expired verification', async () => {
    prisma.otpChallenge.findFirst.mockResolvedValue(null);
    await expect(service.complete(client, dto, options)).rejects.toThrow('already used or expired');
    expect(options.onComplete).not.toHaveBeenCalled();
  });
});
