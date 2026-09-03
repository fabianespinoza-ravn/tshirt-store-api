import type { Category, ProductImage, Sku } from '@prisma/client';
import type { CategoryView } from '../categories/categories.service';

// Separate types, not one with optional fields: the contract's `anyOf`
// validates if any branch passes, so only distinct types plus a
// field-by-field test prevent data leaks (finding 28 in
// docs/DESIGN-ATTACK.md).

export interface ImageView {
  id: string;
  url: string;
}

export interface PublicSkuView {
  id: string;
  size: Sku['size'];
  color: Sku['color'];
  price: number;
  image?: ImageView;
  // Exact only when it's 5 or fewer; `null` means "plenty", never "unknown".
  available: number | null;
  inStock: boolean;
}

export interface ManagerSkuView {
  id: string;
  size: Sku['size'];
  color: Sku['color'];
  price: number;
  image?: ImageView;
  stock: number;
  reserved: number;
  // Always exact: a manager isn't shielded from their own sales velocity.
  available: number;
  inStock: boolean;
}

export interface ProductSummaryView {
  id: string;
  name: string;
  priceFrom: number;
  image: ImageView;
  categories: CategoryView[];
  inStock: boolean;
}

export interface ProductDetailView extends ProductSummaryView {
  description: string;
  images: ImageView[];
  skus: PublicSkuView[];
}

export interface ManagerProductView {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  priceFrom: number | null;
  image?: ImageView;
  images: ImageView[];
  categories: CategoryView[];
  skus: ManagerSkuView[];
}

// Threshold below which exact availability is actually published.
const SCARCITY_THRESHOLD = 5;

export const availableOf = (sku: Pick<Sku, 'stock' | 'reserved'>): number =>
  sku.stock - sku.reserved;

// The cover is the first image by UUIDv7 order (in practice, upload order);
// F8 only needs one unambiguous image, not one the manager gets to pick.
export const coverOf = (images: ImageView[]): ImageView | undefined =>
  images[0];

export const toCategoryViews = (
  rows: { category: Category }[],
): CategoryView[] =>
  rows.map(({ category }) => ({ id: category.id, name: category.name }));

export function toPublicSku(sku: Sku, image?: ImageView): PublicSkuView {
  const available = availableOf(sku);
  return {
    id: sku.id,
    size: sku.size,
    color: sku.color,
    price: sku.price,
    ...(image ? { image } : {}),
    available: available <= SCARCITY_THRESHOLD ? available : null,
    inStock: available > 0,
  };
}

export function toManagerSku(sku: Sku, image?: ImageView): ManagerSkuView {
  const available = availableOf(sku);
  return {
    id: sku.id,
    size: sku.size,
    color: sku.color,
    price: sku.price,
    ...(image ? { image } : {}),
    stock: sku.stock,
    reserved: sku.reserved,
    available,
    inStock: available > 0,
  };
}

// Shared by ProductsService.toDetail and toManager: both need every sku's
// image resolved by id from the same already-loaded image list.
export function mapSkus<V>(
  skus: Sku[],
  images: ImageView[],
  toView: (sku: Sku, image?: ImageView) => V,
): V[] {
  const byId = new Map(images.map((i) => [i.id, i]));
  return skus.map((s) =>
    toView(s, s.imageId ? byId.get(s.imageId) : undefined),
  );
}

// A deliberate decision, not an oversight: aggregation happens in memory over
// the rows Prisma already fetched; with thousands of products the answer
// would be `$queryRaw` with `DISTINCT ON` (finding 30 in
// docs/DESIGN-ATTACK.md).
export function aggregate(skus: Sku[]): {
  priceFrom: number | null;
  inStock: boolean;
} {
  if (skus.length === 0) return { priceFrom: null, inStock: false };

  return {
    priceFrom: Math.min(...skus.map((s) => s.price)),
    inStock: skus.some((s) => availableOf(s) > 0),
  };
}

export type ImageRow = Pick<ProductImage, 'id' | 's3Key'>;
