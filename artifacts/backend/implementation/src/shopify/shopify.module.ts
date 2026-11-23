import { ConsumerModule } from '../consumer/consumer.module';
import { ShopifyExperienceService } from './shopify-experience.service';
import { ShopifyExperienceController } from './shopify-experience.controller';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AdminSecurityModule } from '../common/security/admin-security.module';
import { AccessControlModule } from '../common/access-control/access-control.module';
import { CommunicationModule } from '../communication/communication.module';
import { LoyaltyProgramModule } from '../loyalty-program/loyalty-program.module';
import { JwtVerifyGuard } from '../common/guards/jwt-verify/jwt-verify.guard';
import { VerifyRoleGuard } from '../common/guards/verify-role/verify-role.guard';
import {
  ShopifyAdminController,
  ShopifyController,
} from './shopify.controller';
import { ShopifyService } from './shopify.service';
import { ShopifyOrderService } from './shopify-order.service';
import { ShopifyRedemptionService } from './shopify-redemption.service';
import { ShopifyReconciliationService } from './shopify-reconciliation.service';

@Module({
  imports: [
    ConsumerModule,
    PrismaModule,
    AdminSecurityModule,
    AccessControlModule,
    CommunicationModule,
    LoyaltyProgramModule,
  ],
  controllers: [ShopifyAdminController, ShopifyController, ShopifyExperienceController],
  providers: [
    ShopifyExperienceService,
    JwtVerifyGuard,
    VerifyRoleGuard,
    ShopifyService,
    ShopifyOrderService,
    ShopifyRedemptionService,
    ShopifyReconciliationService,
  ],
})
export class ShopifyModule {}
