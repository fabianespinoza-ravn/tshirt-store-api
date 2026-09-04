import { OrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';

const ADDRESS_FIELD = 255;

/**
 * The body of `POST /orders`. It carries the shipping address and nothing
 * else: the lines come from the caller's active cart, which is what makes
 * the operation a checkout rather than an order builder. Sending line items
 * here would let a client name a price.
 */
export class CheckoutDto {
  @IsString()
  @MaxLength(ADDRESS_FIELD)
  recipientName!: string;

  @IsString()
  @MaxLength(ADDRESS_FIELD)
  line1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(ADDRESS_FIELD)
  line2?: string;

  @IsString()
  @MaxLength(ADDRESS_FIELD)
  city!: string;

  @IsOptional()
  @IsString()
  @MaxLength(ADDRESS_FIELD)
  region?: string;

  @IsString()
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
