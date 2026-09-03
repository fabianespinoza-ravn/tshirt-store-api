import type { Prisma } from '@prisma/client';
import {
  toPublicSku,
  type ImageView,
  type PublicSkuView,
} from '../catalog/views';

/**
 * A cart line reads the product as it is now. `productName` and `unitPrice`
 * come live from the product and the SKU rather than from a snapshot, which
 * is the declared difference from `OrderItem`: an order line freezes what
 * was bought, a cart line shows what is on sale today. The consequence is
 * deliberate and worth saying out loud — a manager who raises a price while
 * carts are open changes what those clients will pay.
 */
export interface CartItemView {
  id: string;
  sku: PublicSkuView;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface CartView {
  items: CartItemView[];
  subtotal: number;
}

// Everything a line needs to render itself: the SKU for the public view, its
// image for the thumbnail, and the product for the name.
export const CART_LINE_INCLUDE = {
  sku: { include: { image: true, product: true } },
} satisfies Prisma.CartItemInclude;

export type CartLineRow = Prisma.CartItemGetPayload<{
  include: typeof CART_LINE_INCLUDE;
}>;

// Reading a cart that was never created is not an error: the client has an
// empty cart until the first line is added.
export const EMPTY_CART: CartView = { items: [], subtotal: 0 };

export function toCartItem(line: CartLineRow, image?: ImageView): CartItemView {
  return {
    id: line.id,
    sku: toPublicSku(line.sku, image),
    productName: line.sku.product.name,
    quantity: line.quantity,
    unitPrice: line.sku.price,
    lineTotal: line.sku.price * line.quantity,
  };
}

export function toCart(items: CartItemView[]): CartView {
  return {
    items,
    subtotal: items.reduce((total, item) => total + item.lineTotal, 0),
  };
}
