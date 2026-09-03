import { IsInt, IsUUID, Max, Min } from 'class-validator';

// The cap the contract puts on a line. It is a validation here and a 409 in
// the service: this rejects a single request asking for more than the cap,
// the service rejects a request whose result would push an existing line
// past it.
export const MAX_LINE_QUANTITY = 99;

export class AddCartItemDto {
  @IsUUID()
  skuId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

export class UpdateCartItemDto {
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}
