import { UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export function authenticateShopifyService(request: FastifyRequest & { rawBody?: Buffer }, timestamp?: string, signature?: string) {
  const key = process.env.SHOPIFY_LOYALTY_SERVICE_SECRET;
  const time = Number(timestamp);
  if (!key || key.length < 32 || !timestamp || !signature || !/^[a-f0-9]{64}$/i.test(signature)) throw new UnauthorizedException('Shopify service signature is required');
  if (!Number.isSafeInteger(time) || Math.abs(Date.now() - time) > 300000) throw new UnauthorizedException('Shopify service signature has expired');
  const expected = createHmac('sha256', key).update(timestamp + '\n' + request.method.toUpperCase() + '\n' + request.url + '\n' + (request.rawBody?.toString('utf8') ?? '')).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new UnauthorizedException('Invalid Shopify service signature');
}

export const privacyHash = (shopId: string, customerId: string) => createHash('sha256').update(shopId + ':' + customerId).digest('hex');
