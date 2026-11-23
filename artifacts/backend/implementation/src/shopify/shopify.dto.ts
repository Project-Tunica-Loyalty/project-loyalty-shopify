import {
  MaxLength,
  MinLength,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';

export class ConnectTokenDto {
  @IsUUID() storeId!: string;
}

export class ConnectShopDto {
  @IsString() @IsNotEmpty() token!: string;
  @IsString() @IsNotEmpty() shopId!: string;
  @Matches(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/) shopDomain!: string;
  @IsString() @IsNotEmpty() currency!: string;
}

export class ShopifyIdentityDto {
  @IsString() @IsNotEmpty() shopId!: string;
  @IsString() @IsNotEmpty() customerId!: string;
}

export class ShopifyDeactivateDto {
  @IsString() @IsNotEmpty() shopId!: string;
  @Matches(/^gid:\/\/shopify\/DiscountCodeNode\/\d+$/) discountId!: string;
}

export class SendShopifyOtpDto extends ShopifyIdentityDto {
  @IsString() @IsNotEmpty() countryCode!: string;
  @IsString() @IsNotEmpty() phoneNumber!: string;
}

export class VerifyShopifyOtpDto extends ShopifyIdentityDto {
  @IsUUID() challengeId!: string;
  @Matches(/^\d{4,8}$/) otp!: string;
}

export class ShopifyRedemptionDto extends ShopifyIdentityDto {
  @IsOptional() @IsIn(['ORDER', 'PRODUCT']) kind?: 'ORDER' | 'PRODUCT';
  @IsOptional() @IsIn(['RESERVE', 'ISSUED', 'FAILED']) action?:
    'RESERVE' | 'ISSUED' | 'FAILED';
  @IsOptional() @IsUUID() redemptionId?: string;
  @IsOptional() @IsString() discountId?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsNumber() @Min(0.01) points?: number;
  @IsOptional() @IsUUID() rewardProductId?: string;
  @IsOptional() @IsNumber() @Min(0.01) cartSubtotal?: number;
}

export class ShopifyIssuedDiscountDto extends ShopifyIdentityDto {
  @IsUUID() redemptionId!: string;
  @IsString() @IsNotEmpty() discountId!: string;
  @Matches(/^[A-Za-z0-9_-]{8,100}$/) code!: string;
}

export class ShopifyRewardConfigDto {
  @IsString() @IsNotEmpty() shopId!: string;
  @IsString() @IsNotEmpty() variantId!: string;
  @IsString() @IsNotEmpty() title!: string;
  @IsNumber() @Min(0.01) pointsCost!: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class ShopifySignupOtpDto extends SendShopifyOtpDto {}
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
  @Matches(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/) shopDomain!: string;
  @IsIn(['customers/data_request', 'customers/redact', 'shop/redact']) topic!: string;
  @IsObject() payload!: { customer?: { id?: string | number }; data_request?: { id?: string | number } };
}

export class ShopifyEventDto {
  @IsString() @IsNotEmpty() shopId!: string;
  @IsString() @IsNotEmpty() webhookId!: string;
  @IsString() @IsNotEmpty() topic!: string;
  @IsObject() payload!: Record<string, unknown>;
}
