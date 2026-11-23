import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { authenticateShopifyService } from './shopify-signature';

describe('Shopify backend authentication', () => {
  const previous = process.env.SHOPIFY_LOYALTY_SERVICE_SECRET;
  beforeEach(() => { process.env.SHOPIFY_LOYALTY_SERVICE_SECRET = 'a'.repeat(64); });
  afterAll(() => { if (previous === undefined) delete process.env.SHOPIFY_LOYALTY_SERVICE_SECRET; else process.env.SHOPIFY_LOYALTY_SERVICE_SECRET = previous; });
  const sign = (time: string, path: string, body = '') => createHmac('sha256', 'a'.repeat(64)).update(time + '\nPOST\n' + path + '\n' + body).digest('hex');
  it('accepts the exact API path and body, rejects tampering and missing API prefixes', () => {
    const time = String(Date.now());
    const request = { method: 'POST', url: '/api/integrations/shopify/events', rawBody: Buffer.from('{"shopId":"1"}') } as FastifyRequest & { rawBody: Buffer };
    expect(() => authenticateShopifyService(request, time, sign(time, request.url, request.rawBody.toString()))).not.toThrow();
    expect(() => authenticateShopifyService(request, time, sign(time, '/integrations/shopify/events', request.rawBody.toString()))).toThrow();
    expect(() => authenticateShopifyService(request, time, sign(time, request.url, '{}'))).toThrow();
    expect(() => authenticateShopifyService(request, time, 'a'.repeat(63))).toThrow();
  });
  it('rejects expired signatures', () => {
    const time = String(Date.now() - 301000);
    expect(() => authenticateShopifyService({ method: 'POST', url: '/api/test' } as FastifyRequest, time, sign(time, '/api/test'))).toThrow('expired');
  });
});
