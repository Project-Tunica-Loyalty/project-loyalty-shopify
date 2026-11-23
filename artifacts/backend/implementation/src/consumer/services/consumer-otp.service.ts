import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { SmsOtpTemplateService } from '../../communication/services/sms-otp-template.service';
import { SmsService } from '../../communication/services/sms.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthRateLimitService } from '../../common/security/auth-rate-limit.service';
import { OtpPurpose } from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';
import { consumerSecurityConfig } from '../security/consumer-security.config';

const LOGIN_RESEND_COOLDOWN_MS = 10_000;

@Injectable()
export class ConsumerOtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly rateLimits: AuthRateLimitService,
    private readonly otpTemplates: SmsOtpTemplateService,
  ) {}

  normalize(countryCode: string, number: string) {
    return `${countryCode.trim()}${number.replace(/\D/g, '')}`;
  }

  async issue(input: {
    purpose: OtpPurpose;
    consumerClientId: string;
    brandId: string | null;
    countryCode: string;
    number: string;
    deviceId?: string;
    ipAddress?: string;
    sessionBinding?: string;
  }) {
    const normalizedPhone = this.normalize(input.countryCode, input.number);
    await Promise.all([
      this.rateLimits.assertAllowed(
        'consumer-otp-mobile',
        `${input.consumerClientId}:${normalizedPhone}`,
        5,
        5 * 60_000,
      ),
      ...(input.deviceId
        ? [
            this.rateLimits.assertAllowed(
              'consumer-otp-device',
              `${input.consumerClientId}:${input.deviceId}`,
              5,
              5 * 60_000,
            ),
          ]
        : []),
      ...(input.ipAddress
        ? [
            this.rateLimits.assertAllowed(
              'consumer-otp-ip',
              `${input.consumerClientId}:${input.ipAddress}`,
              10,
              5 * 60_000,
            ),
          ]
        : []),
    ]);
    const now = new Date();
    const existing = await this.prisma.otpChallenge.findFirst({
      where: {
        purpose: input.purpose,
        sessionBinding: input.sessionBinding ?? null,
        consumerClientId: input.consumerClientId,
        brandId: input.brandId,
        phoneCountryCode: input.countryCode,
        phoneNumber: input.number,
        invalidatedAt: null,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { sentAt: 'desc' },
    });
    if (existing) return this.publicChallenge(existing);
    const recent = await this.prisma.otpChallenge.count({
      where: {
        consumerClientId: input.consumerClientId,
        phoneCountryCode: input.countryCode,
        phoneNumber: input.number,
        sentAt: { gt: new Date(Date.now() - 5 * 60_000) },
      },
    });
    if (recent >= 5)
      throw new HttpException(
        'OTP send limit reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    let account = await this.prisma.consumerAccount.findUnique({
      where: {
        normalizedPhone,
      },
    });
    if (account?.status !== 'ACTIVE') account = null;
    const otp = this.otp();
    const challenge = await this.prisma.otpChallenge.create({
      data: {
        purpose: input.purpose,
        consumerClientId: input.consumerClientId,
        consumerAccountId: account?.id,
        brandId: input.brandId,
        phoneCountryCode: input.countryCode,
        phoneNumber: input.number,
        sessionBinding: input.sessionBinding ?? null,
        codeHash: this.hash(otp),
        expiresAt: new Date(Date.now() + 5 * 60_000),
        resendAvailableAt: new Date(
          Date.now() +
            (input.purpose === OtpPurpose.LOGIN
              ? LOGIN_RESEND_COOLDOWN_MS
              : 60_000),
        ),
      },
    });
    if (!this.testing()) {
      if (!input.brandId)
        await this.sms.sendProjectConsumerOtp({
          to: normalizedPhone,
          otp,
        });
      else
        await this.otpTemplates.send({
          purpose: 'SIGNUP',
          brandId: input.brandId,
          to: this.normalize(input.countryCode, input.number),
          customerName: 'Customer',
          otp,
          requestId: challenge.id,
        });
    }
    return this.publicChallenge(challenge);
  }

  async issueRedemption(input: {
    consumerClientId: string;
    consumerAccountId: string;
    brandId: string;
    pointRedemptionId: string;
    countryCode: string;
    number: string;
    customerName: string;
  }) {
    const otp = this.otp();
    const challenge = await this.prisma.otpChallenge.create({
      data: {
        purpose: OtpPurpose.APP_REDEMPTION,
        consumerClientId: input.consumerClientId,
        consumerAccountId: input.consumerAccountId,
        brandId: input.brandId,
        pointRedemptionId: input.pointRedemptionId,
        phoneCountryCode: input.countryCode,
        phoneNumber: input.number,
        codeHash: this.hash(otp),
        expiresAt: new Date(Date.now() + 5 * 60_000),
        resendAvailableAt: new Date(Date.now() + 60_000),
      },
    });
    if (!this.testing())
      await this.otpTemplates.send({
        purpose: 'REDEMPTION',
        brandId: input.brandId,
        to: this.normalize(input.countryCode, input.number),
        customerName: input.customerName,
        otp,
        requestId: challenge.id,
      });
    return challenge;
  }

  async resend(
    challengeId: string,
    clientId: string,
    purpose: OtpPurpose,
    ipAddress?: string,
  ) {
    if (ipAddress)
      await this.rateLimits.assertAllowed(
        'consumer-otp-resend-ip',
        `${clientId}:${ipAddress}`,
        10,
        10 * 60_000,
      );
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { id: challengeId, consumerClientId: clientId, purpose },
    });
    if (!challenge) throw new NotFoundException('OTP challenge not found');
    if (challenge.consumedAt || challenge.verifiedAt || challenge.invalidatedAt)
      throw new BadRequestException('OTP challenge is no longer active');
    if (challenge.sendCount >= 3)
      throw new HttpException(
        'OTP resend limit reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (challenge.resendAvailableAt && challenge.resendAvailableAt > new Date())
      throw new HttpException(
        'OTP resend cooldown is active',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const otp = this.otp();
    const claimed = await this.prisma.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        verifiedAt: null,
        invalidatedAt: null,
        sendCount: { lt: 3 },
        OR: [
          { resendAvailableAt: null },
          { resendAvailableAt: { lte: new Date() } },
        ],
      },
      data: {
        codeHash: this.hash(otp),
        attempts: 0,
        sendCount: { increment: 1 },
        sentAt: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60_000),
        resendAvailableAt: new Date(
          Date.now() +
            (purpose === OtpPurpose.LOGIN ? LOGIN_RESEND_COOLDOWN_MS : 60_000),
        ),
      },
    });
    if (claimed.count !== 1)
      throw new HttpException(
        'OTP resend cooldown is active',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const updated = await this.prisma.otpChallenge.findUniqueOrThrow({
      where: { id: challenge.id },
    });
    if (!this.testing()) {
      if (!updated.brandId)
        await this.sms.sendProjectConsumerOtp({
          to: this.normalize(updated.phoneCountryCode!, updated.phoneNumber!),
          otp,
        });
      else
        await this.otpTemplates.send({
          purpose:
            updated.purpose === OtpPurpose.APP_REDEMPTION
              ? 'REDEMPTION'
              : 'SIGNUP',
          brandId: updated.brandId,
          to: this.normalize(updated.phoneCountryCode!, updated.phoneNumber!),
          customerName: 'Customer',
          otp,
          requestId: `${updated.id}:${updated.sendCount}`,
        });
    }
    return this.publicChallenge(updated);
  }

  async verify(
    challengeId: string,
    otp: string,
    clientId: string,
    purpose: OtpPurpose,
    consume = false,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const challenge = await db.otpChallenge.findFirst({
      where: { id: challengeId, consumerClientId: clientId, purpose },
    });
    if (!challenge) throw new NotFoundException('OTP challenge not found');
    if (
      challenge.invalidatedAt ||
      challenge.lockedAt ||
      challenge.consumedAt ||
      challenge.expiresAt <= new Date()
    )
      throw new BadRequestException('OTP challenge is not active');
    const expected = Buffer.from(challenge.codeHash, 'hex');
    const received = Buffer.from(this.hash(otp), 'hex');
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      const attempts = challenge.attempts + 1;
      await db.otpChallenge.update({
        where: { id: challenge.id },
        data: {
          attempts,
          ...(attempts >= challenge.maxAttempts
            ? { lockedAt: new Date(), invalidatedAt: new Date() }
            : {}),
        },
      });
      if (
        challenge.purpose === OtpPurpose.APP_REDEMPTION &&
        challenge.pointRedemptionId &&
        challenge.brandId
      )
        await db.loyaltyAuditEvent.create({
          data: {
            brandId: challenge.brandId,
            pointRedemptionId: challenge.pointRedemptionId,
            eventType: 'APP_REDEMPTION_OTP_FAILED',
            metadata: { attempts },
          },
        });
      throw new BadRequestException('Invalid OTP');
    }
    if (!consume)
      return db.otpChallenge.update({
        where: { id: challenge.id },
        data: { verifiedAt: challenge.verifiedAt ?? new Date() },
      });
    const consumed = await db.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        invalidatedAt: null,
        lockedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        verifiedAt: challenge.verifiedAt ?? new Date(),
        consumedAt: new Date(),
      },
    });
    if (consumed.count !== 1)
      throw new BadRequestException('OTP challenge is no longer active');
    return db.otpChallenge.findUniqueOrThrow({
      where: { id: challenge.id },
    });
  }

  private publicChallenge(challenge: {
    id: string;
    phoneCountryCode: string | null;
    phoneNumber: string | null;
    expiresAt: Date;
    resendAvailableAt: Date | null;
  }) {
    const phone = `${challenge.phoneCountryCode ?? ''}${challenge.phoneNumber ?? ''}`;
    return {
      challengeId: challenge.id,
      destinationMasked:
        phone.length > 4
          ? `${phone.slice(0, 3)}******${phone.slice(-4)}`
          : '******',
      expiresAt: challenge.expiresAt,
      resendAvailableInSeconds: challenge.resendAvailableAt
        ? Math.max(
            0,
            Math.ceil(
              (challenge.resendAvailableAt.getTime() - Date.now()) / 1000,
            ),
          )
        : 0,
    };
  }

  private otp() {
    return this.testing()
      ? process.env.CONSUMER_TEST_OTP?.trim() || '123456'
      : String(randomInt(100000, 1_000_000));
  }

  private testing() {
    return process.env.CONSUMER_OTP_TESTING?.trim().toUpperCase() === 'YES';
  }

  private hash(value: string) {
    return createHmac('sha256', consumerSecurityConfig().secret)
      .update(value)
      .digest('hex');
  }
}
