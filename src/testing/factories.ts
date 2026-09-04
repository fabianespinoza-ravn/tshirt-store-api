import {
  CartStatus,
  Color,
  OrderStatus,
  Size,
  UserRole,
  UserState,
  type Cart,
  type CartItem,
  type Category,
  type Order,
  type OrderItem,
  type OrderStatusHistory,
  type Product,
  type ProductImage,
  type ProductLike,
  type Sku,
  type User,
} from '@prisma/client';
import { newId } from '../common/ids';

// Constructors of valid rows for the tests: the default values respect the
// database's CHECKs (`price > 0`, `reserved <= stock`, a GUEST is never
// verified), and each test only declares the override it cares about.
type Overrides<T> = Partial<T>;

const now = () => new Date('2026-08-28T12:00:00.000Z');

export function aUser(overrides: Overrides<User> = {}): User {
  const email =
    overrides.email ??
    `user-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const deletedAt = overrides.deletedAt ?? null;
  return {
    id: newId(),
    email,
    passwordHash: '$argon2id$fake',
    role: UserRole.CLIENT,
    state: UserState.ACTIVE,
    emailVerifiedAt: now(),
    deletedAt,
    // Mirrors `email` unless the row is soft-deleted, matching the
    // liveEmail invariant `auth.service.ts` relies on.
    liveEmail: deletedAt === null ? email : null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

// Freshly registered account: GUEST, unverified and with no credential in users.
export const anUnverifiedUser = (overrides: Overrides<User> = {}): User =>
  aUser({
    passwordHash: null,
    state: UserState.GUEST,
    emailVerifiedAt: null,
    ...overrides,
  });

export const aManager = (overrides: Overrides<User> = {}): User =>
  aUser({ role: UserRole.MANAGER, ...overrides });

export function aCategory(overrides: Overrides<Category> = {}): Category {
  return {
    id: newId(),
    name: `Category ${Math.random().toString(36).slice(2, 6)}`,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function aProduct(overrides: Overrides<Product> = {}): Product {
  return {
    id: newId(),
    name: 'Test T-shirt',
    description: 'Cotton',
    isActive: true,
    deletedAt: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function anImage(
  productId: string,
  overrides: Overrides<ProductImage> = {},
): ProductImage {
  const id = overrides.id ?? newId();
  return {
    id,
    productId,
    s3Key: `products/${productId}/${id}.png`,
    createdAt: now(),
    ...overrides,
  };
}

export function aCart(userId: string, overrides: Overrides<Cart> = {}): Cart {
  const status = overrides.status ?? CartStatus.ACTIVE;
  return {
    id: newId(),
    userId,
    status,
    // Mirrors userId only while the cart is ACTIVE, which is the invariant
    // behind uq_carts_user_active that CartService relies on.
    activeUserId: status === CartStatus.ACTIVE ? userId : null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function aCartItem(
  cartId: string,
  skuId: string,
  overrides: Overrides<CartItem> = {},
): CartItem {
  return {
    id: newId(),
    cartId,
    skuId,
    quantity: 1,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function anOrder(
  userId: string,
  overrides: Overrides<Order> = {},
): Order {
  const status = overrides.status ?? OrderStatus.PENDING;
  const subtotal = overrides.subtotal ?? 2000;
  return {
    id: newId(),
    userId,
    status,
    // Only a PENDING order holds an expiry; anything else has nothing left
    // to expire, which is the invariant the block 4 sweep will depend on.
    expiresAt:
      status === OrderStatus.PENDING
        ? new Date('2026-08-28T12:30:00.000Z')
        : null,
    subtotal,
    orderDiscountAmount: 0,
    total: subtotal,
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Street',
    line2: null,
    city: 'London',
    region: null,
    postalCode: 'E1 6AN',
    deliveredById: null,
    deliveredAt: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function anOrderItem(
  orderId: string,
  skuId: string,
  overrides: Overrides<OrderItem> = {},
): OrderItem {
  return {
    id: newId(),
    orderId,
    skuId,
    // Snapshot columns, not a projection of the SKU: a test that sets these
    // to something the SKU does not say is exercising the point of them.
    productName: 'Snapshot tee',
    unitPrice: 1000,
    quantity: 2,
    createdAt: now(),
    ...overrides,
  };
}

export function anOrderStatusHistory(
  orderId: string,
  overrides: Overrides<OrderStatusHistory> = {},
): OrderStatusHistory {
  return {
    id: newId(),
    orderId,
    status: OrderStatus.PENDING,
    sequence: 0,
    createdAt: now(),
    ...overrides,
  };
}

export function aProductLike(
  userId: string,
  productId: string,
  overrides: Overrides<ProductLike> = {},
): ProductLike {
  return {
    id: newId(),
    userId,
    productId,
    createdAt: now(),
    ...overrides,
  };
}

export function aSku(productId: string, overrides: Overrides<Sku> = {}): Sku {
  return {
    id: newId(),
    productId,
    imageId: null,
    size: Size.M,
    color: Color.BLACK,
    price: 2599,
    stock: 10,
    reserved: 0,
    restockCycle: 0,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

// The shape ProductsService loads with its FULL_INCLUDE, so no test has to
// hand-assemble the nesting and get the join table's `{ category }` wrapper
// wrong.
export function aFullProduct(
  options: {
    product?: Overrides<Product>;
    categories?: Category[];
    images?: ProductImage[];
    skus?: Overrides<Sku>[];
  } = {},
) {
  const product = aProduct(options.product);
  const categories = options.categories ?? [aCategory()];
  const images = options.images ?? [anImage(product.id)];
  const skus = (options.skus ?? [{}]).map((o) => aSku(product.id, o));

  return {
    ...product,
    categories: categories.map((category) => ({
      id: newId(),
      productId: product.id,
      categoryId: category.id,
      createdAt: now(),
      category,
    })),
    images,
    skus,
  };
}

// Real PNG signature (the 8 bytes detectImageType requires) plus padding, so
// the test file also passes the magic-bytes check and not just the declared
// `mimetype`.
const PNG_MAGIC_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// Uploaded file in the shape FileInterceptor produces; the default values
// pass all four of ImagesService's validations (size, declared mimetype,
// real magic bytes), so a test that wants to break one overrides it
// explicitly.
export function aMulterFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  const buffer =
    overrides.buffer ??
    Buffer.concat([PNG_MAGIC_BYTES, Buffer.from('test-image')]);
  return {
    fieldname: 'file',
    originalname: 'tshirt.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: buffer.length,
    buffer,
    stream: undefined as never,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}

// A live token unless said otherwise: expiresAt uses the real Date.now()
// (not the frozen clock of the other columns) because the service compares
// expiry against the actual time.
export function aOneTimeToken(
  userId: string,
  overrides: Partial<{
    id: string;
    tokenHash: string;
    pendingPasswordHash: string | null;
    expiresAt: Date;
    consumedAt: Date | null;
    liveUserId: string | null;
    createdAt: Date;
  }> = {},
) {
  const consumedAt = overrides.consumedAt ?? null;
  return {
    id: newId(),
    userId,
    tokenHash: `hash-${Math.random().toString(36).slice(2, 8)}`,
    pendingPasswordHash: '$argon2id$pending',
    expiresAt: new Date(Date.now() + 3_600_000),
    consumedAt,
    // Mirrors `userId` unless the token has been consumed, matching the
    // liveUserId invariant `auth.service.ts` relies on.
    liveUserId: consumedAt === null ? userId : null,
    createdAt: now(),
    ...overrides,
  };
}

// A refresh token row; a non-null revokedAt is what triggers reuse detection.
export function aRefreshToken(
  userId: string,
  overrides: Partial<{
    id: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  }> = {},
) {
  return {
    id: newId(),
    userId,
    tokenHash: `hash-${Math.random().toString(36).slice(2, 8)}`,
    familyId: newId(),
    expiresAt: new Date(Date.now() + 604_800_000),
    revokedAt: null,
    createdAt: now(),
    ...overrides,
  };
}
