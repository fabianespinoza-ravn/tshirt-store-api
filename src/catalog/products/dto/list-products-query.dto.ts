import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '@shared/common/pagination';

export class ListProductsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
