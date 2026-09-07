import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';

const ADDRESS_FIELD = 255;

/**
 * The body of `POST /orders`. The lines come from the caller's active cart,
 * which is what makes the operation a checkout rather than an order builder.
 * Sending line items here would let a client name a price. The optional promo
 * code only names a campaign: prices and eligibility are recalculated inside
 * the checkout transaction.
 *
 * The four required fields reject the empty string and not only a missing
 * key. `@IsString()` accepts `""`, and this address is copied onto the order
 * and never revisited, so an empty `recipientName` or `postalCode` would
 * leave a row that cannot be delivered with nothing downstream to catch it.
 * `line2` and `region` stay as they are: an optional line that arrives empty
 * is an absent one.
 */
export class CheckoutDto {
  @ApiPropertyOptional({
    description:
      'Promo code to revalidate and reserve atomically with this checkout.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  promoCode?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ADDRESS_FIELD)
  recipientName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ADDRESS_FIELD)
  line1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(ADDRESS_FIELD)
  line2?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ADDRESS_FIELD)
  city!: string;

  @IsOptional()
  @IsString()
  @MaxLength(ADDRESS_FIELD)
  region?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ADDRESS_FIELD)
  postalCode!: string;
}

/**
 * The three filters the brief requires, plus the pagination every collection
 * in this API carries. Money is an integer number of cents here as
 * everywhere else, so a price filter is an integer and not a decimal.
 */
export class ListOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsISO8601()
  placedFrom?: string;

  @IsOptional()
  @IsISO8601()
  placedTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minTotal?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxTotal?: number;
}

/**
 * One route serves every status change and the destination travels here,
 * which is why the role cannot be gated by the decorator alone. See
 * `order-state-machine.ts`.
 */
export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}

/**
 * One immutable transition returned by an order's status-history endpoint.
 * This is a response DTO rather than the service's view interface because
 * Swagger needs runtime metadata to publish the array item schema.
 */
export class OrderStatusEventResponseDto {
  @ApiProperty({ enum: OrderStatus })
  status!: OrderStatus;

  @ApiProperty({ minimum: 0 })
  sequence!: number;

  @ApiProperty({ format: 'date-time' })
  occurredAt!: string;
}
