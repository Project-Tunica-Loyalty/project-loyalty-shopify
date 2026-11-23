import { Body, Controller, Get, Headers, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { authenticateShopifyService } from './shopify-signature';
import { ShopifyExperienceService } from './shopify-experience.service';
import { CompleteShopifySignupDto, ShopifySignupOtpDto, ShopifySignupVerifyDto, ShopifySignupResendDto, ShopifyPrivacyDto, ShopifyDeactivateDto } from './shopify.dto';

@Controller('integrations/shopify')
export class ShopifyExperienceController {
  constructor(private readonly experience: ShopifyExperienceService) {}
  @Get('context')
  context(@Req() request: FastifyRequest, @Headers('x-loyalty-timestamp') time: string, @Headers('x-loyalty-signature') signature: string, @Query('shopId') shopId: string, @Query('shopDomain') domain: string) {
    authenticateShopifyService(request, time, signature);
    return this.experience.context(shopId, domain);
  }
  @Post('customers/signup/otp/send')
  send(@Req() request: FastifyRequest, @Headers('x-loyalty-timestamp') time: string, @Headers('x-loyalty-signature') signature: string, @Body() body: ShopifySignupOtpDto) {
    authenticateShopifyService(request, time, signature); return this.experience.send(body, request.ip);
  }
  @Post('customers/signup/otp/verify')
  verify(@Req() request: FastifyRequest, @Headers('x-loyalty-timestamp') time: string, @Headers('x-loyalty-signature') signature: string, @Body() body: ShopifySignupVerifyDto) {
    authenticateShopifyService(request, time, signature); return this.experience.verify(body);
  }
  @Post('customers/signup/otp/resend')
  resend(@Req() request: FastifyRequest, @Headers('x-loyalty-timestamp') time: string, @Headers('x-loyalty-signature') signature: string, @Body() body: ShopifySignupResendDto) {
    authenticateShopifyService(request, time, signature); return this.experience.resend(body, request.ip);
  }
  @Post('customers/signup/complete')
  complete(@Req() request: FastifyRequest, @Headers('x-loyalty-timestamp') time: string, @Headers('x-loyalty-signature') signature: string, @Body() body: CompleteShopifySignupDto) {
    authenticateShopifyService(request, time, signature); return this.experience.complete(body);
  }
  @Get('discounts/expired')
  expired(@Req() request: FastifyRequest, @Headers('x-loyalty-timestamp') time: string, @Headers('x-loyalty-signature') signature: string, @Query('shopId') shopId: string) {
    authenticateShopifyService(request, time, signature); return this.experience.expired(shopId);
  }
  @Post('discounts/deactivated')
  deactivated(@Req() request: FastifyRequest, @Headers('x-loyalty-timestamp') time: string, @Headers('x-loyalty-signature') signature: string, @Body() body: ShopifyDeactivateDto) {
    authenticateShopifyService(request, time, signature); return this.experience.deactivated(body.shopId, body.discountId);
  }
  @Post('privacy')
  privacy(@Req() request: FastifyRequest, @Headers('x-loyalty-timestamp') time: string, @Headers('x-loyalty-signature') signature: string, @Body() body: ShopifyPrivacyDto) {
    authenticateShopifyService(request, time, signature); return this.experience.privacy(body.shopDomain, body.topic, body.payload);
  }
}
