const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve('../project-loyalty-backend');
const output = path.resolve('artifacts/backend/implementation');
function modify(file, replacements) {
  let text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  for (const [from,to] of replacements) {
    if (!(from instanceof RegExp ? from.test(text) : text.includes(from))) throw new Error('Expected source not found in ' + file + ': ' + String(from).slice(0, 80));
    text = text.replace(from, to);
  }
  fs.mkdirSync(path.dirname(path.join(output,file)),{recursive:true}); fs.writeFileSync(path.join(output,file),text);
}
modify('src/consumer/consumer.module.ts', [['exports: [ConsumerClientKeyService, ConsumerRedemptionService]', 'exports: [ConsumerClientKeyService, ConsumerRedemptionService, ConsumerSignupService, ConsumerOtpService]']]);
modify('src/consumer/services/consumer-signup.service.ts', [
  ['type SignupClaims = {', "type SignupClient = Pick<AuthenticatedConsumerClient, 'id' | 'brandId'>;\n\ntype SignupClaims = {"],
  [/client: AuthenticatedConsumerClient/g, 'client: SignupClient'],
  ['async complete(client: SignupClient, dto: CompleteSignupDto) {', "async complete(client: SignupClient, dto: CompleteSignupDto, options?: { source: 'SHOPIFY'; sessionBinding: string }) {"],
  ['consumedAt: null,\n            invalidatedAt: null,', 'consumedAt: null,\n            ...(options ? { sessionBinding: options.sessionBinding } : {}),\n            invalidatedAt: null,'],
  ['if (!membership)\n          membership =', "if (membership?.blockedAt) throw new ForbiddenException('Customer account is blocked');\n        if (!membership)\n          membership ="],
  ["source: 'CUSTOMER_APP',", "source: options?.source ?? 'CUSTOMER_APP',"],
  ['const session = await this.auth.createSession(result.account.id, client.id);', 'const session = options?.source === \'SHOPIFY\' ? {} : await this.auth.createSession(result.account.id, client.id);'],
]);
modify('src/shopify/shopify.module.ts', [
  ["import { Module }", "import { ConsumerModule } from '../consumer/consumer.module';\nimport { ShopifyExperienceService } from './shopify-experience.service';\nimport { ShopifyExperienceController } from './shopify-experience.controller';\nimport { Module }"],
  ["import { ConsumerOtpService } from '../consumer/services/consumer-otp.service';\n", ''],
  ['    PrismaModule,', '    ConsumerModule,\n    PrismaModule,'],
  ['controllers: [ShopifyAdminController, ShopifyController]', 'controllers: [ShopifyAdminController, ShopifyController, ShopifyExperienceController]'],
  ['    ConsumerOtpService,', '    ShopifyExperienceService,'],
]);
modify('src/shopify/shopify.dto.ts', [
  ["import {\n", "import { Type } from 'class-transformer';\nimport {\n  MaxLength,\n  MinLength,\n"],
  ['export class ConnectTokenDto {', `export class ShopifySignupOtpDto extends SendShopifyOtpDtoPlaceholder {}\n\nexport class ConnectTokenDto {`],
  ['export class ShopifySignupOtpDto extends SendShopifyOtpDtoPlaceholder {}\n\n', ''],
  ["export class ShopifyEventDto {", `export class ShopifySignupOtpDto extends SendShopifyOtpDto {}
export class ShopifySignupVerifyDto extends VerifyShopifyOtpDto {}
export class ShopifySignupResendDto extends ShopifyIdentityDto { @IsUUID() challengeId!: string; }
export class CompleteShopifySignupDto extends ShopifyIdentityDto {
  @IsString() @MinLength(1) @MaxLength(255) name!: string;
  @IsString() @MinLength(1) signupVerificationToken!: string;
  @IsBoolean() termsAccepted!: boolean;
  @IsString() @MinLength(1) @MaxLength(50) termsVersion!: string;
  @IsOptional() @IsBoolean() marketingAccepted?: boolean;
}
export class ShopifyPrivacyDto {
  @Matches(/^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$/) shopDomain!: string;
  @IsIn(['customers/data_request', 'customers/redact', 'shop/redact']) topic!: string;
  @IsObject() payload!: { customer?: { id?: string | number }; data_request?: { id?: string | number } };
}

export class ShopifyEventDto {`],
  ["import { Type } from 'class-transformer';\n", ''],
]);
const originalController=fs.readFileSync(path.join(root,'src/shopify/shopify.controller.ts'),'utf8').replace(/\r\n/g,'\n');
const start=originalController.indexOf('function authenticate('); const end=originalController.indexOf("@Controller('brands",start);
let controller=originalController.slice(0,start)+originalController.slice(end);
controller="import { authenticateShopifyService as authenticate } from './shopify-signature';\n"+controller;
controller=controller.replace("import { createHmac, timingSafeEqual } from 'node:crypto';\n",'').replace('  UnauthorizedException,','  ForbiddenException,');
controller=controller.replace("  @Post('connect-tokens')", `  @Post('rewards')
  @Modules([{ name: SystemModule.LOYALTY_SETTINGS, canUpdate: true }])
  @AllowedRoleNames([DefaultRole.BRAND_OWNER])
  async reward(@Param('brandId') brandId: string, @Body() input: ShopifyRewardConfigDto) {
    const installation = await this.shops.installation(input.shopId);
    if (installation.brandId !== brandId) throw new ForbiddenException('Shop belongs to a different brand');
    return this.shops.configureReward(input);
  }
  @Post('connect-tokens')`);
controller=controller.replace('return this.shops.configureReward(input);\n  }\n  @Post(\'redemptions\')', "throw new ForbiddenException('Use the brand-authorized reward management endpoint');\n  }\n  @Post('redemptions')");
controller=controller.replace("return this.redemptions.fail(input.shopId, input.redemptionId ?? '');", "return this.redemptions.fail(input.shopId, input.redemptionId ?? '', input.customerId);");
fs.writeFileSync(path.join(output,'src/shopify/shopify.controller.ts'),controller);
modify('src/shopify/shopify-redemption.service.ts', [
  ["import { createHash, randomBytes }", "import { Prisma } from '../generated/prisma/client';\nimport { createHash, randomBytes }"],
  ['    const discount = await this.prisma.shopifyDiscountRedemption.create({', `    const cap = Number(version.currentVersion.maximumBillPercentage ?? 0);
    if (input.kind === 'ORDER' && cap <= 0) throw new BadRequestException('A positive bill percentage cap is required');
    const minimumSubtotal = reward ? new Prisma.Decimal(0) : new Prisma.Decimal(redemption.monetaryValue).times(100).div(cap).toDecimalPlaces(2, Prisma.Decimal.ROUND_CEIL);
    const discount = await this.prisma.shopifyDiscountRedemption.upsert({
      where: { pointRedemptionId: redemption.id }, update: {}, create: {`],
  ['      data: {\n        installationId: installation.id,\n        pointRedemptionId: redemption.id,', '        installationId: installation.id,\n        pointRedemptionId: redemption.id,\n        minimumSubtotal,\n        code: this.newCode(),'],
  ['expiresAt: Date;\n    },', 'expiresAt: Date;\n      minimumSubtotal: unknown;\n    },'],
  ['      discountAmount: String(redemption.monetaryValue),', '      discountAmount: String(redemption.monetaryValue),\n      minimumSubtotal: String(discount.minimumSubtotal),'],
  ["    if (!input.discountId || !input.code", "    if (!input.redemptionId || !/^[0-9a-f-]{36}$/i.test(input.redemptionId) || !input.discountId || !input.code"],
  ['async fail(shopId: string, redemptionId: string) {', 'async fail(shopId: string, redemptionId: string, customerId: string) {\n    if (!redemptionId || !customerId) throw new BadRequestException(\'Redemption and customer IDs are required\');'],
  ["    if (discount.status !== 'PENDING')\n      throw new ConflictException('Only pending discounts can fail issuance');", "    if (discount.shopifyCustomerId !== customerId) throw new ConflictException('Redemption customer does not match');\n    if (discount.status === 'FAILED') return { status: 'FAILED' };\n    if (discount.status !== 'PENDING')\n      throw new ConflictException('Only pending discounts can fail issuance');"],
]);
// The upsert's create object replaces the original data wrapper.
let red=fs.readFileSync(path.join(output,'src/shopify/shopify-redemption.service.ts'),'utf8');
red=red.replace('        expiresAt: redemption.reservedUntil,\n      },\n    });','        expiresAt: redemption.reservedUntil,\n      },\n    });');
fs.writeFileSync(path.join(output,'src/shopify/shopify-redemption.service.ts'),red);
modify('prisma/schema/shopify.prisma', [
  ['  expiresAt         DateTime\n  usedOrderId', '  expiresAt         DateTime\n  minimumSubtotal   Decimal @default(0) @db.Decimal(18, 2)\n  deactivatedAt     DateTime?\n  usedOrderId'],
  ['  lastSyncedAt      DateTime @default(now())', '  lastSyncedAt      DateTime @default(now())\n  sourceUpdatedAt   DateTime?'],
]);
fs.appendFileSync(path.join(output,'prisma/schema/shopify.prisma'), '\nmodel ShopifyCustomerPrivacy {\n  id String @id @db.VarChar(64)\n  redactedAt DateTime @default(now())\n  reconsentedAt DateTime?\n}\n');
const migration='prisma/migrations/20261118_shopify_experience/migration.sql';
fs.mkdirSync(path.dirname(path.join(output,migration)),{recursive:true});
fs.writeFileSync(path.join(output,migration), 'ALTER TABLE "ShopifyDiscountRedemption" ADD COLUMN "minimumSubtotal" DECIMAL(18,2) NOT NULL DEFAULT 0, ADD COLUMN "deactivatedAt" TIMESTAMP(3);\nALTER TABLE "ShopifyOrder" ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3);\nCREATE TABLE "ShopifyCustomerPrivacy" ("id" VARCHAR(64) NOT NULL PRIMARY KEY, "redactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "reconsentedAt" TIMESTAMP(3));\n');
console.log('Prepared backend changes in ' + output);
