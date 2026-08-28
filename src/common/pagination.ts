import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// Límites del contrato: limit entre 1 y 100 (20 por defecto), offset hasta un millón para que una petición absurda sea un 400 y no un escaneo secuencial de la tabla.
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

// total exige un COUNT(*) con los mismos filtros que la página, así que toda colección paginada cuesta dos consultas.
export function paginate<T>(
  data: T[],
  total: number,
  query: PaginationQueryDto,
): Paginated<T> {
  return { data, meta: { limit: query.limit, offset: query.offset, total } };
}
