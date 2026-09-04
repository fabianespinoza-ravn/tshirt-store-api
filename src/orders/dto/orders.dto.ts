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
 * The body of `POST /orders`. It carries the shipping address and nothing
 * else: the lines come from the caller's active cart, which is what makes
 * the operation a checkout rather than an order builder. Sending line items
 * here would let a client name a price.
 *
 * The four required fields reject the empty string and not only a missing
 * key. `@IsString()` accepts `""`, and this address is copied onto the order
 * and never revisited, so an empty `recipientName` or `postalCode` would
 * leave a row that cannot be delivered with nothing downstream to catch it.
 * `line2` and `region` stay as they are: an optional line that arrives empty
 * is an absent one.
 */
export class CheckoutDto {
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
