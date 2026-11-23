import { serializePointFields } from '../../common/points';
import { isReviewPhone, REVIEW_PHONE } from '../consumer-review.constants';
import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '../../generated/prisma/client';
import {
  OtpPurpose,
  ReferralRewardStatus,
  ReferralStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReferralService } from '../../referral/services/referral.service';
import type { AuthenticatedConsumerClient } from '../consumer.types';
import type {
  CompleteSignupDto,
  SendConsumerOtpDto,
  VerifyConsumerOtpDto,
} from '../dto/consumer.dto';
import {
  SIGNUP_TOKEN_TTL_SECONDS,
  consumerSecurityConfig,
} from '../security/consumer-security.config';
import { ConsumerOtpService } from './consumer-otp.service';
import { ConsumerAuthService } from './consumer-auth.service';

type SignupClient = Pick<AuthenticatedConsumerClient, 'id' | 'brandId'>;

type SignupClaims = {
  challengeId: string;
  consumerClientId: string;
  brandId: string;
  normalizedPhone: string;
  tokenUse: 'CUSTOMER_SIGNUP';
};

@Injectable()
export class ConsumerSignupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly otp: ConsumerOtpService,
    private readonly auth: ConsumerAuthService,
    private readonly referrals: ReferralService,
  ) {}

  sendOtp(
    client: SignupClient,
    dto: SendConsumerOtpDto,
    ipAddress?: string,
    sessionBinding?: string,
  ) {
    if (isReviewPhone(dto.mobile))
      throw new ForbiddenException('REVIEW_ACCOUNT_LOGIN_ONLY');
    return this.otp.issue({
      purpose: OtpPurpose.SIGNUP,
      consumerClientId: client.id,
      brandId: client.brandId,
      countryCode: dto.mobile.countryCode,
      number: dto.mobile.number,
      deviceId: dto.device?.deviceId,
      ipAddress,
      sessionBinding,
    });
  }

  resendOtp(
    client: SignupClient,
    challengeId: string,
    ipAddress?: string,
  ) {
    return this.otp.resend(
      challengeId,
      client.id,
      OtpPurpose.SIGNUP,
      ipAddress,
    );
  }

  async verifyOtp(
    client: SignupClient,
    dto: VerifyConsumerOtpDto,
  ) {
    const challenge = await this.otp.verify(
      dto.challengeId,
      dto.otp,
      client.id,
      OtpPurpose.SIGNUP,
    );
    const config = consumerSecurityConfig();
    return {
      signupVerificationToken: await this.jwt.signAsync(
        {
          challengeId: challenge.id,
          consumerClientId: client.id,
          brandId: client.brandId,
          normalizedPhone: this.otp.normalize(
            challenge.phoneCountryCode!,
            challenge.phoneNumber!,
          ),
          tokenUse: 'CUSTOMER_SIGNUP',
        },
        {
          secret: config.secret,
          issuer: config.issuer,
          audience: config.audience,
          expiresIn: SIGNUP_TOKEN_TTL_SECONDS,
        },
      ),
      expiresInSeconds: SIGNUP_TOKEN_TTL_SECONDS,
    };
  }

  async complete(client: SignupClient, dto: CompleteSignupDto, options?: { source: 'SHOPIFY'; sessionBinding: string; onComplete?: (tx: Prisma.TransactionClient, membershipId: string) => Promise<void> }) {
    if (
      new Set(dto.consents.map((consent) => consent.type)).size !==
      dto.consents.length
    )
      throw new BadRequestException('Consent types must not be duplicated');
    const required = dto.consents.find((consent) => consent.type === 'TERMS');
    if (!required?.accepted)
      throw new BadRequestException('Terms consent is required');
    const claims = await this.signupClaims(dto.signupVerificationToken);
    if (
      claims.consumerClientId !== client.id ||
      claims.brandId !== client.brandId
    )
      throw new UnauthorizedException('Signup token context does not match');
    if (
      claims.normalizedPhone ===
      `${REVIEW_PHONE.countryCode}${REVIEW_PHONE.number}`
    )
      throw new ForbiddenException('REVIEW_ACCOUNT_LOGIN_ONLY');
    const result = await this.prisma.$transaction(
      async (tx) => {
        const challenge = await tx.otpChallenge.findFirst({
          where: {
            id: claims.challengeId,
            consumerClientId: client.id,
            brandId: client.brandId,
            purpose: OtpPurpose.SIGNUP,
            verifiedAt: { not: null },
            consumedAt: null,
            ...(options ? { sessionBinding: options.sessionBinding } : {}),
            invalidatedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (!challenge)
          throw new ConflictException(
            'Signup verification was already used or expired',
          );
        const normalizedPhone = this.otp.normalize(
          challenge.phoneCountryCode!,
          challenge.phoneNumber!,
        );
        if (normalizedPhone !== claims.normalizedPhone)
          throw new UnauthorizedException('Signup token mobile does not match');
        const account = await tx.consumerAccount.upsert({
          where: { normalizedPhone },
          update: {},
          create: {
            normalizedPhone,
            phoneCountryCode: challenge.phoneCountryCode!,
            phoneNumber: challenge.phoneNumber!,
          },
        });
        if (account.status !== 'ACTIVE')
          throw new UnauthorizedException('Customer account is blocked');
        let membership = await tx.customerBrand.findFirst({
          where: {
            brandId: client.brandId,
            consumerAccountId: account.id,
            deletedAt: null,
          },
        });
        if (!membership) {
          const legacyMembership = await tx.customerBrand.findFirst({
            where: {
              brandId: client.brandId,
              phoneCountryCode: challenge.phoneCountryCode!,
              phoneNumber: challenge.phoneNumber!,
              deletedAt: null,
            },
          });
          if (legacyMembership?.blockedAt)
            throw new UnauthorizedException('Customer account is blocked');
          if (legacyMembership)
            membership = await tx.customerBrand.update({
              where: { id: legacyMembership.id },
              data: { consumerAccountId: account.id },
            });
        }
        if (membership?.blockedAt) throw new ForbiddenException('Customer account is blocked');
        if (!membership)
          membership = await tx.customerBrand.create({
            data: {
              brandId: client.brandId,
              consumerAccountId: account.id,
              name: dto.name.trim(),
              phoneCountryCode: challenge.phoneCountryCode!,
              phoneNumber: challenge.phoneNumber!,
              notificationConsent:
                dto.consents.find((item) => item.type === 'MARKETING_SMS')
                  ?.accepted ?? false,
            },
          });
        for (const consent of dto.consents)
          await tx.customerConsent.upsert({
            where: {
              customerBrandId_consentType_documentVersion: {
                customerBrandId: membership.id,
                consentType: consent.type,
                documentVersion: consent.documentVersion,
              },
            },
            update: {},
            create: {
              consumerAccountId: account.id,
              customerBrandId: membership.id,
              consentType: consent.type,
              documentVersion: consent.documentVersion,
              accepted: consent.accepted,
              source: options?.source ?? 'CUSTOMER_APP',
            },
          });
        const referral = dto.referralCode
          ? await this.attachReferral(
              tx,
              client.brandId,
              membership.id,
              dto.referralCode,
            )
          : null;
        await options?.onComplete?.(tx, membership.id);
        const consumed = await tx.otpChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null },
          data: { consumedAt: new Date(), consumerAccountId: account.id },
        });
        if (consumed.count !== 1)
          throw new ConflictException('Signup verification was already used');
        return { account, membership, referralId: referral?.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    const referral = result.referralId
      ? await this.referrals
          .evaluateAndPayout(client.brandId, result.referralId)
          .catch(() =>
            this.prisma.referral.findUnique({
              where: { id: result.referralId },
            }),
          )
      : null;
    const session = options?.source === 'SHOPIFY' ? {} : await this.auth.createSession(result.account.id, client.id);
    return {
      ...session,
      signup: {
        customerBrandId: result.membership.id,
        referral: referral
          ? {
              status: referral.status,
              rewardStatus: referral.rewardStatus,
              rewardedAt: referral.rewardedAt,
            }
          : null,
      },
    };
  }

  async context(client: SignupClient, referralCode?: string) {
    const brand = await this.prisma.brand.findFirstOrThrow({
      where: { id: client.brandId, deletedAt: null, status: 'ACTIVE' },
      include: {
        referralProgram: { include: { currentVersion: true } },
        loyaltyProgram: { include: { currentVersion: true } },
      },
    });
    const referral = referralCode
      ? await this.validateReferral(client.brandId, referralCode)
      : null;
    return {
      brand: {
        id: brand.id,
        code: brand.code,
        name: brand.name,
        image: brand.image,
      },
      referral,
      referralProgram: brand.referralProgram?.currentVersion
        ? {
            enabled: brand.referralProgram.currentVersion.programEnabled,
            referrerRewardPoints: Number(
              brand.referralProgram.currentVersion.referrerRewardPoints,
            ),
            referredRewardPoints: Number(
              brand.referralProgram.currentVersion.referredRewardPoints,
            ),
            heading: brand.referralProgram.currentVersion.referralHeading,
            termsSummary: brand.referralProgram.currentVersion.termsSummary,
          }
        : null,
      loyaltyProgram: serializePointFields(
        brand.loyaltyProgram?.currentVersion,
      ),
    };
  }

  async validateReferral(brandId: string, code: string) {
    const profile = await this.prisma.referralProfile.findFirst({
      where: {
        brandId,
        referralCode: code.trim().toUpperCase(),
        customerBrand: { deletedAt: null, blockedAt: null },
      },
      include: { customerBrand: { select: { name: true } } },
    });
    if (!profile) return { valid: false, reason: 'INVALID_REFERRAL_CODE' };
    return { valid: true, referrerName: profile.customerBrand.name };
  }

  private async signupClaims(token: string) {
    const config = consumerSecurityConfig();
    for (const secret of [config.secret, config.previousSecret].filter(
      (value): value is string => Boolean(value),
    )) {
      try {
        const claims = await this.jwt.verifyAsync<SignupClaims>(token, {
          secret,
          issuer: config.issuer,
          audience: config.audience,
        });
        if (claims.tokenUse === 'CUSTOMER_SIGNUP') return claims;
      } catch {
        // Try the immediately previous signing key during rotations.
      }
    }
    throw new UnauthorizedException('Invalid signup verification token');
  }

  private async attachReferral(
    tx: Prisma.TransactionClient,
    brandId: string,
    referredCustomerId: string,
    code: string,
  ) {
    const profile = await tx.referralProfile.findFirst({
      where: {
        brandId,
        referralCode: code.trim().toUpperCase(),
        customerBrand: { deletedAt: null, blockedAt: null },
      },
    });
    const program = await tx.referralProgram.findUnique({
      where: { brandId },
      include: { currentVersion: true },
    });
    if (!profile || !program?.currentVersion?.programEnabled)
      throw new BadRequestException('Referral code is not valid');
    if (profile.customerBrandId === referredCustomerId)
      throw new BadRequestException('Self-referral is not allowed');
    const existing = await tx.referral.findFirst({
      where: { brandId, referredCustomerId, deletedAt: null },
    });
    if (existing) return existing;
    return tx.referral.create({
      data: {
        brandId,
        programVersionId: program.currentVersion.id,
        referrerCustomerId: profile.customerBrandId,
        referredCustomerId,
        referralCode: profile.referralCode,
        status: ReferralStatus.SIGNED_UP,
        rewardStatus: ReferralRewardStatus.PENDING,
        joinedAt: new Date(),
      },
    });
  }
}
