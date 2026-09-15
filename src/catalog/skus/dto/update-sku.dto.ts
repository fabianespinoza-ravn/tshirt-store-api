import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MAX_MONEY } from './create-sku.dto';

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
