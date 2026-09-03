import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';

export class ListProductsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
