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
  OrderStatus,
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
      can(['read', 'update'], 'Order');
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
      can('create', 'Order');
      can(['read', 'update'], 'Order', { userId: user.id });
    }

    // ─── Extension point: the DELIVERY rules ────────────────────────────
    //
    // The two lines below are the whole authorization model for the courier,
    // and they are the student's to own rather than the assistant's. They
    // arrived with the orders block; nothing in this repository asserts them
    // yet, and `app-ability.spec.ts` carries the `it.todo` stubs that name
    // every case they have to answer.
    //
    // What the matrix asks for, spelled out as rules:
    //
    //   DELIVERY · read·update · Order · { status: OrderStatus.SHIPPED }
    //   DELIVERY · read·update · Order · { deliveredById: <the caller> }
    //
    // Both come from docs/AUTHORIZATION-MATRIX.md: the `listOrders`,
    // `getOrder` and `updateOrderStatus` rows of the Orders table, each
    // reading "DELIVERY within scope"; the line under that table that defines
    // the scope — "any SHIPPED order, plus the DELIVERED ones they
    // delivered"; and the per-role destination table, which gives DELIVERY
    // exactly `SHIPPED → DELIVERED`.
    //
    // Why the rule and not only the guard. `PoliciesGuard` denies what the
    // ability does not grant, so with no `read`/`update` rule on `Order` a
    // courier gets 403 on all three routes and the feature does not exist.
    // With the rule but without the condition it is worse than absent:
    // `OrdersService.scope` folds whatever this builder produces straight
    // into the Prisma `where`, and an unconditional rule yields `{}`, which
    // matches every row — so the courier reads every client's order with a
    // 200 that no test about a 403 would ever notice.
    //
    // Two decisions in these conditions are worth re-deciding rather than
    // inheriting:
    //
    //   - `{ deliveredById: user.id }` states "the ones they delivered", not
    //     "the DELIVERED ones they delivered". Today the column is written
    //     only in the statement that sets `OrderStatus.DELIVERED`, so the two
    //     sets coincide; a later transition out of DELIVERED would widen this
    //     rule silently. Adding `status: OrderStatus.DELIVERED` to it is the
    //     narrower reading of the matrix.
    //   - `update` on any SHIPPED order is broader than the destination
    //     table. What stops a courier cancelling a shipment is
    //     `order-state-machine.ts`, not this rule, and that is deliberate:
    //     one route carries every destination, so the ability cannot see it.
    // ────────────────────────────────────────────────────────────────────
    if (user?.role === UserRole.DELIVERY) {
      can(['read', 'update'], 'Order', { status: OrderStatus.SHIPPED });
      can(['read', 'update'], 'Order', { deliveredById: user.id });
    }

    return build();
  }
}
