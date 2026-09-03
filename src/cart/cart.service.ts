import { Injectable } from '@nestjs/common';
import { accessibleBy } from '@casl/prisma';
import { CartStatus, type Cart, type Prisma, type Sku } from '@prisma/client';
import {
  AppAbilityFactory,
  type AppAction,
} from '../auth/casl/app-ability.factory';
import { NOT_DELETED } from '../catalog/query';
import { availableOf, type ImageView } from '../catalog/views';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { newId } from '../common/ids';
import { loadOrThrow } from '../common/load-or-throw';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  CART_LINE_INCLUDE,
  EMPTY_CART,
  toCart,
  toCartItem,
  type CartLineRow,
  type CartView,
} from './cart.views';
import { MAX_LINE_QUANTITY } from './dto/cart.dto';

export interface AddedCartItem {
  cart: CartView;
  /** False when the SKU was already in the cart and its line grew instead. */
  created: boolean;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly abilities: AppAbilityFactory,
    private readonly storage: StorageService,
  ) {}

  /**
   * The row scope, straight from the ability, folded into the Prisma
   * `where`. With no rule for the caller CASL returns `{ OR: [] }`, which
   * matches nothing, so a role the matrix does not grant reads an empty
   * cart instead of somebody else's.
   *
   * This is the only thing standing between a client and another client's
   * cart: `PoliciesGuard` gates by role and nothing more. A method here
   * that forgets to apply it does not get a 403, it returns the wrong row.
   */
  private cartScope(
    user: AuthenticatedUser,
    action: AppAction,
  ): Prisma.CartWhereInput {
    return accessibleBy(this.abilities.createForUser(user), action).ofType(
      'Cart',
    );
  }

  // CartItem has no owner column of its own: ownership climbs to the cart,
  // so the rule's condition reaches through the relation.
  private itemScope(
    user: AuthenticatedUser,
    action: AppAction,
  ): Prisma.CartItemWhereInput {
    return accessibleBy(this.abilities.createForUser(user), action).ofType(
      'CartItem',
    );
  }

  async getCart(user: AuthenticatedUser): Promise<CartView> {
    const cart = await this.prisma.cart.findFirst({
      where: {
        AND: [this.cartScope(user, 'read'), { status: CartStatus.ACTIVE }],
      },
      include: { items: { include: CART_LINE_INCLUDE } },
    });

    return cart ? this.toView(cart.items) : EMPTY_CART;
  }

  /**
   * The cart is created on the first line, not by a route of its own, so a
   * client who never adds anything never gets a row.
   */
  async addItem(
    user: AuthenticatedUser,
    skuId: string,
    quantity: number,
  ): Promise<AddedCartItem> {
    const sku = await loadOrThrow(
      () =>
        this.prisma.sku.findFirst({
          where: { id: skuId, product: NOT_DELETED },
        }),
      'SKU does not exist.',
    );

    const cart = await this.activeCart(user);
    const existing = await this.prisma.cartItem.findUnique({
      where: { cartId_skuId: { cartId: cart.id, skuId } },
    });

    // Adding a SKU already in the cart grows that line instead of opening a
    // second one, which is what uq_cart_items_cart_sku enforces underneath.
    const wanted = (existing?.quantity ?? 0) + quantity;
    this.assertLineFits(wanted, sku);

    if (existing) {
      await this.prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: wanted },
      });
    } else {
      await this.prisma.cartItem.create({
        data: { id: newId(), cartId: cart.id, skuId, quantity },
      });
    }

    return { cart: await this.getCart(user), created: !existing };
  }

  async updateItem(
    user: AuthenticatedUser,
    cartItemId: string,
    quantity: number,
  ): Promise<CartView> {
    const item = await this.loadItem(user, cartItemId, 'update');
    this.assertLineFits(quantity, item.sku);

    await this.prisma.cartItem.update({
      where: { id: item.id },
      data: { quantity },
    });

    return this.getCart(user);
  }

  async removeItem(
    user: AuthenticatedUser,
    cartItemId: string,
  ): Promise<CartView> {
    const item = await this.loadItem(user, cartItemId, 'delete');
    await this.prisma.cartItem.delete({ where: { id: item.id } });

    return this.getCart(user);
  }

  /**
   * Somebody else's line answers 404 and never 403, because the scope is
   * part of the query: as far as this method can tell, the row does not
   * exist. A 403 would confirm the identifier belongs to someone.
   */
  private loadItem(
    user: AuthenticatedUser,
    cartItemId: string,
    action: AppAction,
  ) {
    return loadOrThrow(
      () =>
        this.prisma.cartItem.findFirst({
          where: { AND: [this.itemScope(user, action), { id: cartItemId }] },
          include: { sku: true },
        }),
      'Cart item does not exist.',
    );
  }

  // Creating the caller's own cart needs no row scope: `userId` comes from
  // the token, so there is no identifier here that could name another
  // client's row.
  private async activeCart(user: AuthenticatedUser): Promise<Cart> {
    const existing = await this.prisma.cart.findFirst({
      where: {
        AND: [this.cartScope(user, 'read'), { status: CartStatus.ACTIVE }],
      },
    });
    if (existing) return existing;

    return this.prisma.cart.create({
      data: {
        id: newId(),
        userId: user.id,
        // Mirror column: only an ACTIVE cart carries it, and the unique
        // index on it is what allows one active cart per user.
        activeUserId: user.id,
        status: CartStatus.ACTIVE,
      },
    });
  }

  /**
   * Two different 409s on purpose. Availability can change on its own, so
   * waiting is a remedy; the per-line cap never does, so it is a plain
   * conflict and the client has to ask for less.
   */
  private assertLineFits(quantity: number, sku: Sku): void {
    if (quantity > MAX_LINE_QUANTITY) {
      throw new ProblemException(
        Problems.conflict,
        `A cart line cannot hold more than ${MAX_LINE_QUANTITY} units.`,
      );
    }

    const available = availableOf(sku);
    if (quantity > available) {
      throw new ProblemException(
        Problems.stockUnavailable,
        `Only ${available} unit(s) of that SKU are available.`,
      );
    }
  }

  // URLs are presigned, so resolving a line's thumbnail is asynchronous.
  private async toView(lines: CartLineRow[]): Promise<CartView> {
    const items = await Promise.all(
      lines.map(async (line) => {
        const image: ImageView | undefined = line.sku.image
          ? {
              id: line.sku.image.id,
              url: await this.storage.urlFor(line.sku.image.s3Key),
            }
          : undefined;
        return toCartItem(line, image);
      }),
    );

    return toCart(items);
  }
}
