import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Color, Size } from '@prisma/client';

// Ceiling on amounts: matches the limit of PostgreSQL's integer column.
export const MAX_MONEY = 2_147_483_647;

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
