import { Injectable } from '@nestjs/common';
import { accessibleBy } from '@casl/prisma';
import {
  CartStatus,
  OrderStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import {
  AppAbilityFactory,
  type AppAction,
} from '../auth/casl/app-ability.factory';
import { availableOf } from '../catalog/views';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { newId, parseDuration } from '../common/ids';
import { loadOrThrow } from '../common/load-or-throw';
import { paginate, type Paginated } from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../prisma/prisma.service';
import type { CheckoutDto, ListOrdersQueryDto } from './dto/orders.dto';
import {
  destinationsFor,
  releasesStock,
  TransitionVerdict,
  verdictFor,
} from './order-state-machine';
import { ORDER_INCLUDE, toOrder, type OrderView } from './orders.views';

/**
 * How long a PENDING order holds its stock. Nothing sweeps expired orders
 * yet — that arrives with the queue in block 4 — so today this column is
 * written and read and never acted on, which means an abandoned checkout
 * keeps its units reserved. Said out loud because it is a real hole, not a
 * detail.
 */
export const PENDING_ORDER_TTL_MS = parseDuration('30m');

/** The transaction client, which is not the same type as PrismaService. */
type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly abilities: AppAbilityFactory,
  ) {}

  /**
   * The row scope from the ability, folded into the Prisma `where`. With no
   * rule for the caller CASL yields `{ OR: [] }`, which matches nothing, so
   * a role the matrix does not grant reads an empty list rather than
   * somebody else's orders.
   *
   * As in the cart, this is the only thing between one client and another's
   * rows: `PoliciesGuard` gates by role and stops there. A method here that
   * forgets the scope does not answer 403 — it answers 200 with the wrong
   * order.
   */
  private scope(
    user: AuthenticatedUser,
    action: AppAction,
  ): Prisma.OrderWhereInput {
    return accessibleBy(this.abilities.createForUser(user), action).ofType(
      'Order',
    );
  }

  /**
   * Reserving the stock and writing the order are one transaction, and the
   * isolation level is `Serializable` on purpose.
   *
   * Availability is `stock - reserved`, which Prisma cannot express as a
   * `where` on an atomic update, so the check and the increment are two
   * statements. At a weaker isolation level two concurrent checkouts can
   * both read the same `reserved`, both decide there is room, and both
   * write — one unit oversold, with no error anywhere. Serializable makes
   * the database refuse the second one instead, as P2034, which
   * `prisma.translator.ts` already turns into the 409 that tells the client
   * to try again.
   */
  async checkout(
    user: AuthenticatedUser,
    dto: CheckoutDto,
  ): Promise<OrderView> {
    await this.refusePendingOrder(user);

    const cart = await this.prisma.cart.findFirst({
      where: {
        AND: [
          accessibleBy(this.abilities.createForUser(user), 'read').ofType(
            'Cart',
          ),
          { status: CartStatus.ACTIVE },
        ],
      },
      include: { items: { include: { sku: { include: { product: true } } } } },
    });

    if (!cart || cart.items.length === 0) {
      throw new ProblemException(
        Problems.cartNotCheckoutable,
        'The cart is empty.',
      );
    }

    const orderId = await this.prisma.$transaction(
      async (tx) => this.placeOrder(tx, user, cart, dto),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.getOne(user, orderId);
  }

  async list(
    user: AuthenticatedUser,
    query: ListOrdersQueryDto,
  ): Promise<Paginated<OrderView>> {
    const where: Prisma.OrderWhereInput = {
      AND: [this.scope(user, 'read'), filtersOf(query)],
    };

    // Same filters on both halves, or the total describes a different set
    // from the page it belongs to.
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        // Matches idx_orders_user_created_id; the id breaks ties so two
        // orders placed in the same millisecond do not swap between pages.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.order.count({ where }),
    ]);

    return paginate(rows.map(toOrder), total, query);
  }

  async getOne(user: AuthenticatedUser, orderId: string): Promise<OrderView> {
    return toOrder(await this.loadOrder(user, orderId, 'read'));
  }

  /**
   * The status change, with the two refusals kept apart: a role that can
   * never reach the destination is a 403, a role that can but not from
   * here is a 409. `order-state-machine.ts` decides both.
   */
  async updateStatus(
    user: AuthenticatedUser,
    orderId: string,
    status: OrderStatus,
  ): Promise<OrderView> {
    const order = await this.loadOrder(user, orderId, 'update');
    this.assertTransition(order.status, status, user);

    await this.prisma.$transaction(
      async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status,
            // A PENDING order is the only one holding an expiry. Once it
            // leaves that state the column has nothing left to say, and a
            // stale date would make the sweep in block 4 act on an order it
            // has no business touching.
            expiresAt: null,
          },
        });

        if (releasesStock(status)) {
          await this.releaseReservations(tx, order.items);
        }

        await this.recordStatus(tx, order.id, status);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.getOne(user, order.id);
  }

  /**
   * Somebody else's order answers 404 and never 403, because the scope is
   * part of the query: as far as this method can tell, the row does not
   * exist. The matrix says so for `getOrder` in as many words — a 403 there
   * would confirm that the identifier belongs to someone.
   */
  private loadOrder(
    user: AuthenticatedUser,
    orderId: string,
    action: AppAction,
  ) {
    return loadOrThrow(
      () =>
        this.prisma.order.findFirst({
          where: { AND: [this.scope(user, action), { id: orderId }] },
          include: ORDER_INCLUDE,
        }),
      'Order does not exist.',
    );
  }

  private assertTransition(
    from: OrderStatus,
    to: OrderStatus,
    user: AuthenticatedUser,
  ): void {
    const verdict = verdictFor(from, to, user.role);

    if (verdict === TransitionVerdict.ForbiddenForRole) {
      const allowed = destinationsFor(user.role);
      throw new ProblemException(
        Problems.forbidden,
        allowed.length === 0
          ? 'This role cannot change an order status.'
          : `This role can only move an order to ${allowed.join(' or ')}.`,
      );
    }

    if (verdict === TransitionVerdict.IllegalFromState) {
      throw new ProblemException(
        Problems.conflict,
        `An order in ${from} cannot move to ${to}.`,
      );
    }
  }

  /**
   * One pending order at a time, which is what the contract's
   * `order-already-pending` says and the only 409 of the seven that carries
   * an extension: the client needs to know when the hold expires to decide
   * between waiting and paying.
   */
  private async refusePendingOrder(user: AuthenticatedUser): Promise<void> {
    const pending = await this.prisma.order.findFirst({
      where: {
        AND: [this.scope(user, 'read'), { status: OrderStatus.PENDING }],
      },
      orderBy: { createdAt: 'desc' },
    });

    if (pending) {
      throw new ProblemException(
        Problems.orderAlreadyPending,
        'Pay the pending order or wait for it to expire.',
        { expiresAt: pending.expiresAt?.toISOString() ?? null },
      );
    }
  }

  private async placeOrder(
    tx: Tx,
    user: AuthenticatedUser,
    cart: CartWithLines,
    dto: CheckoutDto,
  ): Promise<string> {
    const orderId = newId();
    let subtotal = 0;

    for (const line of cart.items) {
      // Re-read inside the transaction: the availability the cart showed
      // was true when the line was added, which may have been days ago.
      const sku = await loadOrThrow(
        () => tx.sku.findUnique({ where: { id: line.skuId } }),
        'A cart line refers to a SKU that no longer exists.',
        Problems.itemWithdrawn,
      );

      if (line.sku.product.deletedAt || !line.sku.product.isActive) {
        throw new ProblemException(
          Problems.itemWithdrawn,
          `${line.sku.product.name} is no longer for sale.`,
        );
      }

      const available = availableOf(sku);
      if (line.quantity > available) {
        throw new ProblemException(
          Problems.stockUnavailable,
          `Only ${available} unit(s) of ${line.sku.product.name} are available.`,
        );
      }

      await tx.sku.update({
        where: { id: sku.id },
        data: { reserved: { increment: line.quantity } },
      });

      subtotal += sku.price * line.quantity;

      await tx.orderItem.create({
        data: {
          id: newId(),
          orderId,
          skuId: sku.id,
          // Frozen here, on purpose: this is what makes the history survive
          // a rename or a price change.
          productName: line.sku.product.name,
          unitPrice: sku.price,
          quantity: line.quantity,
        },
      });
    }

    await tx.order.create({
      data: {
        id: orderId,
        userId: user.id,
        status: OrderStatus.PENDING,
        expiresAt: new Date(Date.now() + PENDING_ORDER_TTL_MS),
        subtotal,
        // No promo codes in this block, so the discount is zero and the
        // total is the subtotal. Both columns exist already.
        orderDiscountAmount: 0,
        total: subtotal,
        recipientName: dto.recipientName,
        line1: dto.line1,
        line2: dto.line2 ?? null,
        city: dto.city,
        region: dto.region ?? null,
        postalCode: dto.postalCode,
      },
    });

    await this.recordStatus(tx, orderId, OrderStatus.PENDING);

    // The cart is spent. Clearing the mirror column is what frees the user
    // to start another one: uq_carts_user_active is a plain unique on a
    // nullable column, so only an ACTIVE cart occupies it.
    await tx.cart.update({
      where: { id: cart.id },
      data: { status: CartStatus.CHECKED_OUT, activeUserId: null },
    });

    return orderId;
  }

  private async releaseReservations(
    tx: Tx,
    items: readonly { skuId: string; quantity: number }[],
  ): Promise<void> {
    for (const item of items) {
      await tx.sku.update({
        where: { id: item.skuId },
        data: { reserved: { decrement: item.quantity } },
      });
    }
  }

  /**
   * Every status the order has held, in order. `sequence` is unique per
   * order, so counting the rows already written is what the next one gets
   * — inside the transaction, where the count cannot move underneath.
   */
  private async recordStatus(
    tx: Tx,
    orderId: string,
    status: OrderStatus,
  ): Promise<void> {
    const sequence = await tx.orderStatusHistory.count({ where: { orderId } });

    await tx.orderStatusHistory.create({
      data: { id: newId(), orderId, status, sequence },
    });
  }
}

type CartWithLines = Prisma.CartGetPayload<{
  include: { items: { include: { sku: { include: { product: true } } } } };
}>;

/** The three filters the brief names, plus nothing else. */
function filtersOf(query: ListOrdersQueryDto): Prisma.OrderWhereInput {
  const placed =
    query.placedFrom || query.placedTo
      ? {
          createdAt: {
            ...(query.placedFrom ? { gte: new Date(query.placedFrom) } : {}),
            ...(query.placedTo ? { lte: new Date(query.placedTo) } : {}),
          },
        }
      : {};

  const priced =
    query.minTotal !== undefined || query.maxTotal !== undefined
      ? {
          total: {
            ...(query.minTotal !== undefined ? { gte: query.minTotal } : {}),
            ...(query.maxTotal !== undefined ? { lte: query.maxTotal } : {}),
          },
        }
      : {};

  return {
    ...(query.status ? { status: query.status } : {}),
    ...placed,
    ...priced,
  };
}
