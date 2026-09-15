import type { Prisma } from '@prisma/client';

// A live product: not soft-deleted. Shared between ProductsService and
// SkusService through the `product` relation, so both sides of the FK agree
// on what "live" means.
export const NOT_DELETED: Prisma.ProductWhereInput = { deletedAt: null };
