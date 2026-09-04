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

    // The CLIENT rules for the cart and the like, from
    // docs/AUTHORIZATION-MATRIX.md:
    //
    //   CLIENT · read                 · Cart        · the cart's userId
    //   CLIENT · create·update·delete · CartItem    · the line's cart is the caller's
    //   CLIENT · create·delete        · ProductLike · the like's userId
    //
    // All three are CLIENT only, and a MANAGER is meant to receive 403 on
    // every one of them. That is why `can('manage', 'all')` for MANAGER
    // would be wrong here: it is one of the six operations the matrix says
    // such a rule breaks in silence.
    //
    // The conditions are not decoration, and two facts about their shape
    // were verified against @casl/prisma 2.0.2 rather than remembered:
    //
    //   - `accessibleBy(ability, action).ofType('Cart')` is the API in this
    //     version. The v1 spelling `accessibleBy(ability, action).Cart`
    //     type-checks against nothing and evaluates to `undefined`, and an
    //     `undefined` Prisma `where` matches EVERY row.
    //   - A conditional rule yields `{ OR: [ ...the condition ] }`. An
    //     unconditional one yields `{}` and no rule at all yields
    //     `{ OR: [] }`, which match every row and no row respectively.
    //
    // So dropping the condition from `read Cart` would not merely expose a
    // cart: CartService.activeCart reuses the first ACTIVE cart the scope
    // matches, so the next `POST /cart/items` would write a line into a
    // stranger's cart. An unconditional CartItem rule would let any line be
    // updated or deleted by id. Neither is something the service can
    // notice, which is why its unit tests assert the `where` these rules
    // produce rather than the problem it throws.
    //
    // CartItem has no owner column, so its condition goes through the
    // relation. A condition naming a `userId` column on CartItem does not
    // exist in the model and fails as a 500 rather than leaking, which is
    // broken instead of open, and still wrong.

    if (user?.role === UserRole.CLIENT) {
      can('read', 'Cart', { userId: user.id });
      can(['create', 'update', 'delete'], 'CartItem', {
        cart: { is: { userId: user.id } },
      });
      can(['create', 'delete'], 'ProductLike', { userId: user.id });
    }

    // ------------------------------------------------------------------
    // Extension point: the rules for `Order`.
    //
    // Nothing below grants them yet, so every route in src/orders answers
    // 403 until they exist. The authorization model is the student's to
    // write, as the cart's was.
    //
    // The rows, from docs/AUTHORIZATION-MATRIX.md:
    //
    //   CLIENT   · create        · Order · —
    //   CLIENT   · read·update   · Order · the order's userId
    //   MANAGER  · read·update   · Order · every order
    //   DELIVERY · read·update   · Order · any SHIPPED, plus the DELIVERED
    //                                      ones they delivered
    //
    // Four things about this subject that the cart did not raise:
    //
    //   - **MANAGER is unconditional here, and that is correct.** In block 2
    //     an unconditional rule was the hazard, because a manager was not
    //     supposed to reach a cart at all. Here the matrix says a manager
    //     sees every order, so `{}` from `accessibleBy` — which matches
    //     every row — is exactly the intent. Same shape, opposite meaning:
    //     read the matrix row, not the pattern.
    //   - **`create` needs no condition.** `OrdersService.checkout` takes
    //     the `userId` from the token and never addresses a row by an
    //     identifier the caller supplied, so there is nothing to scope. A
    //     condition there would be decoration.
    //   - **DELIVERY's scope is two conditions, not one**, and `can` called
    //     twice for the same action ORs them. "Any SHIPPED" is a condition
    //     on `status`; "the DELIVERED ones they delivered" is a condition on
    //     `deliveredById`. Both are a `where`, so both belong here.
    //   - **The ability does not decide destinations.** Who may move an
    //     order to which status lives in `src/orders/order-state-machine.ts`,
    //     because the contract exposes one route with the destination in the
    //     body and a static decorator cannot see it. A rule here that tried
    //     to express "may cancel" would be unenforceable.
    //
    // The `.ofType('Order')` spelling and the `{ OR: [] }` / `{}` behaviour
    // are the same as documented above for the cart.
    // ------------------------------------------------------------------

    return build();
  }
}
