import { DiscountType } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const INT32_MAX = 2_147_483_647;
const PROMO_CODE_MAX_LENGTH = 100;

export class CreatePromoCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROMO_CODE_MAX_LENGTH)
  code!: string;

  @IsEnum(DiscountType)
  type!: DiscountType;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT32_MAX)
  discountValue!: number;

  @IsISO8601()
  expiresAt!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(INT32_MAX)
  usageLimit!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(INT32_MAX)
  minimumPurchaseAmount?: number;
}

/** `code` and `type` are immutable once the campaign has been published. */
export class UpdatePromoCodeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT32_MAX)
  discountValue?: number;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(INT32_MAX)
  usageLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(INT32_MAX)
  minimumPurchaseAmount?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ValidatePromoCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROMO_CODE_MAX_LENGTH)
  promoCode!: string;
}

/** Runtime response metadata for Swagger; service views remain plain values. */
export class PromoCodeResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: DiscountType })
  type!: DiscountType;

  @ApiProperty({ minimum: 1 })
  discountValue!: number;

  @ApiProperty({ nullable: true, minimum: 0, type: Number })
  minimumPurchaseAmount!: number | null;

  @ApiProperty({ minimum: 0 })
  usageLimit!: number;

  @ApiProperty({ minimum: 0 })
  usageCount!: number;

  @ApiProperty({ minimum: 0 })
  usageReserved!: number;

  @ApiProperty({ minimum: 0 })
  usageAvailable!: number;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty()
  isActive!: boolean;
}

export class PromoCodeValidationResponseDto {
  @ApiProperty()
  promoCode!: string;

  @ApiProperty({ minimum: 0 })
  discountAmount!: number;

  @ApiProperty({ minimum: 50 })
  total!: number;
}

class PromoCodePageMetaResponseDto {
  @ApiProperty({ minimum: 1, maximum: 100 })
  limit!: number;

  @ApiProperty({ minimum: 0 })
  offset!: number;

  @ApiProperty({ minimum: 0 })
  total!: number;
}

export class PromoCodePageResponseDto {
  @ApiProperty({ type: [PromoCodeResponseDto] })
  data!: PromoCodeResponseDto[];

  @ApiProperty({ type: PromoCodePageMetaResponseDto })
  meta!: PromoCodePageMetaResponseDto;
}
