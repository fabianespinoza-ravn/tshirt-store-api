import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// Contract limits: limit between 1 and 100 (20 by default), offset up to a
// million so an absurd request is a 400 and not a sequential table scan.
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  offset: number = 0;
}

export interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}

// total requires a COUNT(*) with the same filters as the page, so every
// paginated collection costs two queries.
export function paginate<T>(
  data: T[],
  total: number,
  query: PaginationQueryDto,
): Paginated<T> {
  return { data, meta: { limit: query.limit, offset: query.offset, total } };
}
