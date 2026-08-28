import {
  Color,
  Size,
  UserRole,
  UserState,
  type Category,
  type Product,
  type ProductImage,
  type Sku,
  type User,
} from '@prisma/client';
import { newId } from '../common/ids';

// Constructores de filas válidas para los tests: los valores por defecto respetan los CHECK de la base (`price > 0`, `reserved <= stock`, GUEST nunca verificado), y cada test sólo declara la sobreescritura que le importa.
type Overrides<T> = Partial<T>;

const now = () => new Date('2026-08-28T12:00:00.000Z');

export function aUser(overrides: Overrides<User> = {}): User {
  return {
    id: newId(),
    email: `user-${Math.random().toString(36).slice(2, 8)}@example.test`,
    passwordHash: '$argon2id$fake',
    role: UserRole.CLIENT,
    state: UserState.ACTIVE,
    emailVerifiedAt: now(),
    deletedAt: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

// Cuenta recién registrada: GUEST, sin verificar y sin credencial en users.
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
    name: `Categoría ${Math.random().toString(36).slice(2, 6)}`,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function aProduct(overrides: Overrides<Product> = {}): Product {
  return {
    id: newId(),
    name: 'Camiseta de prueba',
    description: 'Algodón',
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

// La forma que ProductsService carga con su FULL_INCLUDE, evitando que cada test arme a mano el anidamiento y se equivoque con la envoltura `{ category }` de la tabla puente.
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

// Fichero subido con la forma que deja FileInterceptor; los valores por defecto pasan las tres validaciones de ImagesService, así que un test que quiera romper una la sobreescribe explícitamente.
export function aMulterFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  const buffer = overrides.buffer ?? Buffer.from('imagen-de-prueba');
  return {
    fieldname: 'file',
    originalname: 'camiseta.png',
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

// Token vivo salvo que se diga lo contrario: expiresAt usa Date.now() real (no el reloj congelado de las demás columnas) porque el servicio compara la caducidad contra la hora real.
export function aOneTimeToken(
  userId: string,
  overrides: Partial<{
    id: string;
    tokenHash: string;
    pendingPasswordHash: string | null;
    expiresAt: Date;
    consumedAt: Date | null;
    createdAt: Date;
  }> = {},
) {
  return {
    id: newId(),
    userId,
    tokenHash: `hash-${Math.random().toString(36).slice(2, 8)}`,
    pendingPasswordHash: '$argon2id$pendiente',
    expiresAt: new Date(Date.now() + 3_600_000),
    consumedAt: null,
    createdAt: now(),
    ...overrides,
  };
}

// Fila de refresh token; revokedAt no nulo es lo que dispara la detección de reuso.
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
