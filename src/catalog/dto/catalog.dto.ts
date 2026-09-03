import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Color, Size } from '@prisma/client';
import { PaginationQueryDto } from '../../common/pagination';

// Ceiling on amounts: matches the limit of PostgreSQL's integer column.
const MAX_MONEY = 2_147_483_647;

// ---------------------------------------------------------------- products

export class ListProductsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  categoryIds!: string[];
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// -------------------------------------------------------------------- SKUs

export class CreateSkuDto {
  @IsEnum(Size)
  size!: Size;

  @IsEnum(Color)
  color!: Color;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MONEY)
  price!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  stock!: number;

  @IsOptional()
  @IsUUID()
  imageId?: string;
}

export class UpdateSkuDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MONEY)
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY)
  stock?: number;

  // `null` detaches the image (a way back that doesn't depend on another one
  // existing); omitting the field means "don't touch it".
  @IsOptional()
  @IsUUID(undefined, { each: false })
  imageId?: string | null;
}
