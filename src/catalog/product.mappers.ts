import type { Category, ProductImage, Sku } from '@prisma/client';
import type { CategoryView } from './categories.service';

// Tipos separados, no uno con campos opcionales: el `anyOf` del contrato valida si cualquier rama pasa, así que solo tipos distintos más un test campo a campo evitan fugas de datos (hallazgo 28).

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
  // Exacta sólo cuando es 5 o menos; `null` significa suficiente, nunca desconocida.
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
  // Exacta siempre: al manager no se le oculta la velocidad de venta, es suya.
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

// Umbral por debajo del cual la disponibilidad exacta sí se publica.
const SCARCITY_THRESHOLD = 5;

export const availableOf = (sku: Pick<Sku, 'stock' | 'reserved'>): number =>
  sku.stock - sku.reserved;

// La portada es la primera imagen por orden de UUIDv7 (en la práctica, orden de subida); F8 sólo necesita una imagen sin ambigüedad, no que el manager la elija.
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

// Decisión deliberada, no un descuido: se agregan en memoria sobre las filas que Prisma ya trajo; con miles de productos la respuesta sería `$queryRaw` con `DISTINCT ON` (hallazgo 30).
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
