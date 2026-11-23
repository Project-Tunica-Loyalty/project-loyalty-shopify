import { RedisModule } from '../common/redis/redis.module';
import { ConsumerReviewSessionService } from './services/consumer-review-session.service';
import { ConsumerReviewDataService } from './services/consumer-review-data.service';
import { Module } from '@nestjs/common';
import { CommunicationModule } from '../communication/communication.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AdminSecurityModule } from '../common/security/admin-security.module';
import { LoyaltyProgramModule } from '../loyalty-program/loyalty-program.module';
import { ReferralModule } from '../referral/referral.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { PetpoojaModule } from '../pos/petpooja/petpooja.module';
import { ConsumerOrderController } from './controllers/consumer-order.controller';
import { PetpoojaOrderCallbackController } from './controllers/petpooja-order-callback.controller';
import { AppOrderPricingService } from './services/app-order-pricing.service';
import { AppOrderPetpoojaService } from './services/app-order-petpooja.service';
import { AppOrderService } from './services/app-order.service';
import { ConsumerAppController } from './controllers/consumer-app.controller';
import { ConsumerClientAdminController } from './controllers/consumer-client-admin.controller';
import { ConsumerAuthController } from './controllers/consumer-auth.controller';
import { ConsumerRedemptionController } from './controllers/consumer-redemption.controller';
import { ConsumerSignupController } from './controllers/consumer-signup.controller';
import { PetpoojaRedemptionResultController } from './controllers/petpooja-redemption-result.controller';
import {
  ConsumerAccessGuard,
  ConsumerClientGuard,
} from './security/consumer-auth.guard';
import { ConsumerClientKeyService } from './security/consumer-client-key.service';
import { ConsumerAuthService } from './services/consumer-auth.service';
import { ConsumerClientAdminService } from './services/consumer-client-admin.service';
import { ConsumerOtpService } from './services/consumer-otp.service';
import { ConsumerProfileService } from './services/consumer-profile.service';
import { ConsumerNotificationService } from './services/consumer-notification.service';
import { ConsumerQueryService } from './services/consumer-query.service';
import { ConsumerRedemptionService } from './services/consumer-redemption.service';
import { ConsumerSignupService } from './services/consumer-signup.service';

@Module({
  imports: [
    RedisModule,
    PrismaModule,
    AdminSecurityModule,
    CommunicationModule,
    LoyaltyProgramModule,
    ReferralModule,
    FeedbackModule,
    PetpoojaModule,
  ],
  controllers: [
    ConsumerAuthController,
    ConsumerClientAdminController,
    ConsumerSignupController,
    ConsumerAppController,
    ConsumerRedemptionController,
    PetpoojaRedemptionResultController,
    ConsumerOrderController,
    PetpoojaOrderCallbackController,
  ],
  providers: [
    ConsumerReviewSessionService,
    ConsumerReviewDataService,
    ConsumerClientKeyService,
    ConsumerClientGuard,
    ConsumerAccessGuard,
    ConsumerOtpService,
    ConsumerProfileService,
    ConsumerAuthService,
    ConsumerClientAdminService,
    ConsumerSignupService,
    ConsumerQueryService,
    ConsumerNotificationService,
    ConsumerRedemptionService,
    AppOrderPricingService,
    AppOrderPetpoojaService,
    AppOrderService,
  ],
  exports: [ConsumerClientKeyService, ConsumerRedemptionService, ConsumerSignupService, ConsumerOtpService],
})
export class ConsumerModule {}
