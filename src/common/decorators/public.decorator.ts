import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Marks an operation as reachable without a token so the JWT guard can be
// global; the list lives here and not in the guard so it can't drift from
// the contract if someone moves a path.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
