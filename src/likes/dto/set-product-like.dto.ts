import { IsBoolean } from 'class-validator';

// One idempotent route sets and clears the like, so the body carries the
// state the caller wants rather than the operation to perform.
export class SetProductLikeDto {
  @IsBoolean()
  liked!: boolean;
}

export interface ProductLikeView {
  liked: boolean;
}
