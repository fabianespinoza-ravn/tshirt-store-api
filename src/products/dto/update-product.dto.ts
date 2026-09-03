import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

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
