import { authenticateShopifyService as authenticate } from './shopify-signature';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import { JwtVerifyGuard } from '../common/guards/jwt-verify/jwt-verify.guard';
import { VerifyRoleGuard } from '../common/guards/verify-role/verify-role.guard';
import { Scope } from '../common/decorators/scope/scope.decorator';
import { Modules } from '../common/decorators/modules/modules.decorator';
import { AllowedRoleNames } from '../common/decorators/allowed-role-names/allowed-role-names.decorator';
import { DefaultRole } from '../common/enums/default-roles.enums';
import { SystemModule } from '../common/enums/modules.enums';
import type { FastifyRequest } from 'fastify';
import { ShopifyService } from './shopify.service';
import { ShopifyOrderService } from './shopify-order.service';
import { ShopifyRedemptionService } from './shopify-redemption.service';
import {
  ConnectShopDto,
  ConnectTokenDto,
  SendShopifyOtpDto,
  ShopifyEventDto,
  ShopifyIdentityDto,
  ShopifyIssuedDiscountDto,
  ShopifyRedemptionDto,
  ShopifyRewardConfigDto,
  VerifyShopifyOtpDto,
} from './shopify.dto';

@Controller('brands/:brandId/shopify')
@UseGuards(JwtVerifyGuard, VerifyRoleGuard)
@Scope({ type: 'brand' })
export class ShopifyAdminController {
  constructor(private readonly shops: ShopifyService) {}
  @Get('rewards')
  @Modules([{ name: SystemModule.LOYALTY_SETTINGS, canRead: true }])
  async rewards(@Param('brandId') brandId: string, @Query('shopId') shopId: string) {
    const installation = await this.shops.installation(shopId);
    if (installation.brandId !== brandId) throw new ForbiddenException('Shop belongs to a different brand');
    return this.shops.adminRewards(installation.id);
  }
  @Post('rewards')
  @Modules([{ name: SystemModule.LOYALTY_SETTINGS, canUpdate: true }])
  @AllowedRoleNames([DefaultRole.BRAND_OWNER])
  async reward(@Param('brandId') brandId: string, @Body() input: ShopifyRewardConfigDto) {
    const installation = await this.shops.installation(input.shopId);
    if (installation.brandId !== brandId) throw new ForbiddenException('Shop belongs to a different brand');
    return this.shops.configureReward(input);
  }
  @Post('connect-tokens')
  @Modules([{ name: SystemModule.LOYALTY_SETTINGS, canUpdate: true }])
  @AllowedRoleNames([DefaultRole.BRAND_OWNER])
  create(@Param('brandId') brandId: string, @Body() input: ConnectTokenDto) {
    return this.shops.createConnectionToken(brandId, input.storeId);
  }
}

@Controller('integrations/shopify')
export class ShopifyController {
  constructor(
    private readonly shops: ShopifyService,
    private readonly orders: ShopifyOrderService,
    private readonly redemptions: ShopifyRedemptionService,
  ) {}

  private auth(req: FastifyRequest, timestamp?: string, signature?: string) {
    authenticate(req, timestamp, signature);
  }

  @Post('installations/connect')
  connect(
    @Req() req: FastifyRequest,
    @Headers('x-loyalty-timestamp') time: string,
    @Headers('x-loyalty-signature') sig: string,
    @Body() input: ConnectShopDto,
  ) {
    this.auth(req, time, sig);
    return this.shops.connect(input);
  }
  @Post('customers/otp/send')
  sendOtp(
    @Req() req: FastifyRequest,
    @Headers('x-loyalty-timestamp') time: string,
    @Headers('x-loyalty-signature') sig: string,
    @Body() input: SendShopifyOtpDto,
  ) {
    this.auth(req, time, sig);
    return this.shops.sendOtp(
      input.shopId,
      input.customerId,
      input.countryCode,
      input.phoneNumber,
    );
  }
  @Post('customers/otp/verify')
  verifyOtp(
    @Req() req: FastifyRequest,
    @Headers('x-loyalty-timestamp') time: string,
    @Headers('x-loyalty-signature') sig: string,
    @Body() input: VerifyShopifyOtpDto,
  ) {
    this.auth(req, time, sig);
    return this.shops.verifyOtp(
      input.shopId,
      input.customerId,
      input.challengeId,
      input.otp,
    );
  }
  @Get('customers/me/balance')
  balance(
    @Req() req: FastifyRequest,
    @Headers('x-loyalty-timestamp') time: string,
    @Headers('x-loyalty-signature') sig: string,
    @Query() input: ShopifyIdentityDto,
  ) {
    this.auth(req, time, sig);
    return this.shops.balance(input);
  }
  @Get('rewards')
  rewards(
    @Req() req: FastifyRequest,
    @Headers('x-loyalty-timestamp') time: string,
    @Headers('x-loyalty-signature') sig: string,
    @Query('shopId') shopId: string,
  ) {
    this.auth(req, time, sig);
    return this.shops.rewards(shopId);
  }
  @Post('rewards')
  configureReward(
    @Req() req: FastifyRequest,
    @Headers('x-loyalty-timestamp') time: string,
    @Headers('x-loyalty-signature') sig: string,
    @Body() input: ShopifyRewardConfigDto,
  ) {
    this.auth(req, time, sig);
    throw new ForbiddenException('Use the brand-authorized reward management endpoint');
  }
  @Post('redemptions')
  reserve(
    @Req() req: FastifyRequest,
    @Headers('x-loyalty-timestamp') time: string,
    @Headers('x-loyalty-signature') sig: string,
    @Headers('idempotency-key') key: string,
    @Body() input: ShopifyRedemptionDto,
  ) {
    this.auth(req, time, sig);
    if (input.action === 'ISSUED')
      return this.redemptions.issued(input as ShopifyIssuedDiscountDto);
    if (input.action === 'FAILED')
      return this.redemptions.fail(input.shopId, input.redemptionId ?? '', input.customerId);
    return this.redemptions.reserve(input, key);
  }
  @Post('events')
  event(
    @Req() req: FastifyRequest,
    @Headers('x-loyalty-timestamp') time: string,
    @Headers('x-loyalty-signature') sig: string,
    @Body() input: ShopifyEventDto,
  ) {
    this.auth(req, time, sig);
    return this.orders.accept(
      input.shopId,
      input.webhookId,
      input.topic,
      input.payload,
    );
  }
}
