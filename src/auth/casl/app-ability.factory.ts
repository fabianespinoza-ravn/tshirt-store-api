import { Injectable } from '@nestjs/common';
import {
  type Cart,
  type CartItem,
  type Category,
  type Order,
  type PaymentLink,
  type Product,
  type ProductImage,
  type ProductLike,
  type PromoCode,
  type Sku,
  UserRole,
} from '@prisma/client';
import { AbilityBuilder } from '@casl/ability';
import {
  createPrismaAbility,
  type PrismaAbility,
  type PrismaQuery,
  type Subjects,
} from '@casl/prisma';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

export type AppAction = 'create' | 'read' | 'update' | 'delete';

/** Static names that can appear in @CheckPolicies. */
export type AppSubjectName =
  | 'Category'
  | 'Product'
  | 'ProductImage'
  | 'Sku'
  | 'ProductLike'
  | 'Cart'
  | 'CartItem'
  | 'Order'
  | 'PaymentLink'
  | 'PromoCode';

export type AppSubjects = Subjects<{
  Category: Category;
  Product: Product;
  ProductImage: ProductImage;
  Sku: Sku;
  ProductLike: ProductLike;
  Cart: Cart;
  CartItem: CartItem;
  Order: Order;
  PaymentLink: PaymentLink;
  PromoCode: PromoCode;
}>;

export type AppAbility = PrismaAbility<[AppAction, AppSubjects], PrismaQuery>;

@Injectable()
export class AppAbilityFactory {
  createForUser(user: AuthenticatedUser | undefined): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createPrismaAbility);

    if (user?.role === UserRole.MANAGER) {
      can(['create', 'update', 'delete'], 'Category');
      can(['create', 'update', 'delete'], 'Product');
      can(['create', 'delete'], 'ProductImage');
      can(['create', 'update'], 'Sku');
    }

    // ------------------------------------------------------------------
    // Extension point: the CLIENT rules for the cart and the like.
    //
    // Nothing below this line exists yet, and until it does every route in
    // src/cart and src/likes answers 403: PoliciesGuard denies what the
    // ability does not grant. The code is written and unreachable on
    // purpose — the authorization model is the student's to write.
    //
    // The rows to express, from docs/AUTHORIZATION-MATRIX.md:
    //
    //   CLIENT · read                    · Cart        · the cart's userId
    //   CLIENT · create·update·delete     · CartItem    · the line's cart is the caller's
    //   CLIENT · create·delete            · ProductLike · the like's userId
    //
    // All three are CLIENT only. A MANAGER must receive 403 on all of them,
    // which is why `can('manage', 'all')` for MANAGER would be wrong: it is
    // one of the six operations the matrix says such a rule breaks in
    // silence.
    //
    // Two things about the shape, both verified against @casl/prisma 2.0.2
    // rather than remembered:
    //
    //   - `accessibleBy(ability, action).ofType('Cart')` is the API in this
    //     version. The v1 spelling `accessibleBy(ability, action).Cart`
    //     type-checks against nothing and evaluates to `undefined`, and an
    //     `undefined` Prisma `where` matches EVERY row.
    //   - An unconditional rule yields `{}`, which also matches every row.
    //     A conditional one yields `{ OR: [ ...the condition ] }`, and no
    //     rule at all yields `{ OR: [] }`, which matches nothing.
    //
    // So the condition here is not decoration. Written unconditionally,
    // `read Cart` does not merely expose a cart: CartService.activeCart
    // reuses the first ACTIVE cart the scope matches, so the next
    // `POST /cart/items` writes a line into a stranger's cart. An
    // unconditional CartItem rule lets any line be updated or deleted by
    // id. Neither is something the service can notice.
    //
    // CartItem has no owner column, so its condition goes through the
    // relation — `{ cart: { is: { userId: ... } } }`. A condition naming a
    // `userId` column on CartItem does not exist in the model and fails as
    // a 500 rather than leaking, which is broken instead of open, and still
    // wrong.
    // ------------------------------------------------------------------

    if (user?.role === UserRole.CLIENT) {
      can('read', 'Cart', { userId: user.id });
      can(['create', 'update', 'delete'], 'CartItem', {
        cart: { is: { userId: user.id } },
      });
      can(['create', 'delete'], 'ProductLike', { userId: user.id });
    }

    return build();
  }
}
