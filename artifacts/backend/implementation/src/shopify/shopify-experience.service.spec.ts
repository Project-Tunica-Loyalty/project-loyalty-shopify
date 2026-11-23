import { ShopifyExperienceService } from './shopify-experience.service';

describe('Shopify signup and tenant boundaries', () => {
  const prisma = {
    consumerClient: { findUniqueOrThrow: jest.fn() },
    otpChallenge: { findUnique: jest.fn(), update: jest.fn() },
    shopifyInstallation: { findUnique: jest.fn() },
    brand: { findFirstOrThrow: jest.fn() },
    shopifyCustomerLink: { findUnique: jest.fn(), create: jest.fn() },
    shopifyCustomerPrivacy: { updateMany: jest.fn() },
  };
  const shops = { installation: jest.fn() };
  const signup = { sendOtp: jest.fn(), verifyOtp: jest.fn(), complete: jest.fn() };
  const service = new ShopifyExperienceService(prisma as never, shops as never, signup as never);
  const oldEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SHOPIFY_BRAND_ID = 'brand-1'; process.env.SHOPIFY_ALLOWED_SHOPS = 'brand.myshopify.com';
    process.env.SHOPIFY_TERMS_URL = 'https://brand.example/terms'; process.env.SHOPIFY_PRIVACY_URL = 'https://brand.example/privacy'; process.env.SHOPIFY_TERMS_VERSION = 'v1';
    shops.installation.mockResolvedValue({ id: 'installation-1', brandId: 'brand-1', consumerClientId: 'client-1' });
    prisma.consumerClient.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', brandId: 'brand-1', enabled: true, revokedAt: null });
    prisma.brand.findFirstOrThrow.mockResolvedValue({ name: 'Brand' });
    prisma.shopifyCustomerLink.findUnique.mockResolvedValue(null);
    signup.sendOtp.mockResolvedValue({ challengeId: 'challenge-1' });
    signup.complete.mockResolvedValue({ signup: { customerBrandId: 'member-1' } });
  });
  afterAll(() => { process.env = oldEnv; });
  it('binds signup challenges to the verified Shopify customer', async () => {
    await service.send({ shopId: 'shop-1', customerId: 'customer-1', countryCode: '+91', phoneNumber: '9999999999' });
    const binding = signup.sendOtp.mock.calls[0][3];
    prisma.otpChallenge.findUnique.mockResolvedValue({ sessionBinding: binding });
    await expect(service.verify({ shopId: 'shop-1', customerId: 'other-customer', challengeId: 'challenge-1', otp: '123456' })).rejects.toThrow('another Shopify customer');
    expect(signup.verifyOtp).not.toHaveBeenCalled();
    await service.verify({ shopId: 'shop-1', customerId: 'customer-1', challengeId: 'challenge-1', otp: '123456' });
    expect(signup.verifyOtp).toHaveBeenCalledTimes(1);
  });
  it('requires current terms and sends optional marketing consent separately', async () => {
    const input = { shopId: 'shop-1', customerId: 'customer-1', name: 'Member', signupVerificationToken: 'verified-token', termsAccepted: true, termsVersion: 'v1', marketingAccepted: false };
    await expect(service.complete({ ...input, termsAccepted: false })).rejects.toThrow('current brand terms');
    expect(signup.complete).not.toHaveBeenCalled();
    await service.complete(input);
    expect(signup.complete.mock.calls[0][1].consents).toEqual([{ type: 'TERMS', accepted: true, documentVersion: 'v1' }, { type: 'MARKETING_SMS', accepted: false, documentVersion: 'v1' }]);
    expect(signup.complete.mock.calls[0][2].source).toBe('SHOPIFY');
  });
  it('does not overwrite an existing Shopify-to-member mapping', async () => {
    prisma.shopifyCustomerLink.findUnique.mockResolvedValue({ customerBrandId: 'original' });
    await expect(service.complete({ shopId: 'shop-1', customerId: 'customer-1', name: 'Other', signupVerificationToken: 'token', termsAccepted: true, termsVersion: 'v1' })).resolves.toEqual({ linked: true, customerBrandId: 'original' });
    expect(signup.complete).not.toHaveBeenCalled();
  });
  it('rejects unrelated shops and mismatched brand installations', async () => {
    await expect(service.context('shop-1', 'other.myshopify.com')).rejects.toThrow('not allowed');
    prisma.shopifyInstallation.findUnique.mockResolvedValue({ brandId: 'other-brand', shopDomain: 'brand.myshopify.com' });
    await expect(service.context('shop-1', 'brand.myshopify.com')).rejects.toThrow('different brand');
  });
});
