import { Injectable } from '@nestjs/common';
import { accessibleBy } from '@casl/prisma';
import {
  CartStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
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
import { StripeService } from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { recordStatus, releaseReservations } from './order-writes';
import type { CheckoutDto, ListOrdersQueryDto } from './dto/orders.dto';
import {
  destinationsFor,
  releasesStock,
  TransitionVerdict,
  verdictFor,
} from './order-state-machine';
import {
  ORDER_INCLUDE,
  toOrder,
  type CheckoutOrderView,
  type OrderView,
} from './orders.views';

/**
 * How long a PENDING order holds its stock.
 *
 * Two things release it, from opposite directions. `settlePendingOrder`
 * below catches the owner coming back to buy again, in that request's own
 * transaction. `OrdersSweepService` catches the owner who never comes back,
 * once a minute, which is the case that would otherwise keep units reserved
 * against everybody else forever.
 *
 * They race on purpose and it is safe: both carry `status: PENDING` as a
 * precondition on the write, so whichever moves the row owns its
 * reservations and the other returns nothing.
 */
export const PENDING_ORDER_TTL_MS = parseDuration('30m');

/**
 * What the checkout transaction hands back: enough to create the intent
 * without reading the order again, and no more. The amount is carried
 * rather than re-read because it was decided inside the transaction that
 * reserved the stock, and a second read could see a different one.
 */
interface PlacedOrder {
  id: string;
  total: number;
}

/** The client inside `$transaction`, which is not the same type as PrismaService. */
type Tx = Prisma.TransactionClient;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly abilities: AppAbilityFactory,
    private readonly stripe: StripeService,
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
   * Everything the checkout decides happens inside one `Serializable`
   * transaction, and that placement is the point rather than a detail.
   *
   * Availability is `stock - reserved`, which Prisma cannot express as a
   * `where` on an atomic update, so the check and the increment are two
   * statements. `Serializable` only protects a decision whose reads are in
   * the transaction's read set: a precondition read *before* `$transaction`
   * opens is invisible to it, and the database will happily let a concurrent
   * request invalidate it. So the pending-order check, the cart read, the
   * SKU re-reads and every write are all in here — two overlapping checkouts
   * cannot turn one cart into two orders, and the loser is refused as P2034,
   * which `prisma.translator.ts` already serves as the 409 that says retry.
   */
  async checkout(
    user: AuthenticatedUser,
    dto: CheckoutDto,
  ): Promise<CheckoutOrderView> {
    const placed = await this.prisma.$transaction(
      async (tx) => {
        await this.settlePendingOrder(tx, user);
        const cart = await this.loadCheckoutableCart(tx, user);
        return this.placeOrder(tx, user, cart, dto);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const clientSecret = await this.startPayment(placed);

    // Read after the payment row exists, not before. Reading first cost
    // nothing visible except the one field this branch added: the view
    // derives `paymentMethod` from the `Payment` relation, so a checkout
    // that had just written a PAYMENT_INTENT row still answered null with
    // it sitting in the database. The transaction hands back the total so
    // the intent can be created without a read of its own.
    return { ...(await this.getOne(user, placed.id)), clientSecret };
  }

  /**
   * Creates the intent and records the attempt, after the reservation has
   * already committed.
   *
   * **Stripe is called outside the transaction on purpose.** An HTTP round
   * trip inside a `Serializable` transaction holds the reservation — and the
   * locks under it — for as long as a third party takes to answer, which
   * turns their latency into this database's contention. The cost of being
   * outside is a window: the order can exist with no intent. That window is
   * survivable and the other arrangement is not, because `createPaymentIntent`
   * keys on the order's id, so asking again returns the same intent rather
   * than a second one, and the sweep cancels whatever it finds.
   *
   * The `Payment` row is written after Stripe answers, because it is the
   * intent's id that makes the row worth having. Its status is `PENDING`:
   * the intent exists and nothing has been charged. Only the webhook's
   * settlement moves it, which is why this method never writes `SUCCEEDED`.
   */
  private async startPayment(order: PlacedOrder): Promise<string> {
    const intent = await this.stripe.createPaymentIntent(order);

    await this.prisma.payment.create({
      data: {
        id: newId(),
        orderId: order.id,
        method: PaymentMethod.PAYMENT_INTENT,
        status: PaymentStatus.PENDING,
        amount: order.total,
        stripePaymentIntentId: intent.id,
      },
    });

    // Non-null because a created intent always carries one; the SDK types it
    // as nullable for intents read back in states this one cannot be in.
    return intent.client_secret ?? '';
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
   * never reach the destination is a 403, a role that can but not from here
   * is a 409. `order-state-machine.ts` decides both.
   *
   * The write carries the status it was judged against as a precondition,
   * for the same reason the checkout moved its reads inside the transaction:
   * the row was read before this one opened, so `Serializable` cannot refuse
   * a concurrent request that moved it in between. Two overlapping
   * cancellations would otherwise both pass the state machine and give the
   * same reservation back twice.
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
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: order.status },
          data: {
            status,
            // A PENDING order is the only one holding an expiry. Once it
            // leaves that state the column has nothing left to say, and a
            // stale date would make the sweep in block 4 act on an order it
            // has no business touching.
            expiresAt: null,
            // The one transition that records who performed it, and the
            // ability is the reason. DELIVERY reaches an order two ways —
            // any SHIPPED one, or a DELIVERED one it delivered — so a
            // courier who completes a delivery without this loses sight of
            // the order in the same statement that completes it: no longer
            // SHIPPED, and nobody's delivery.
            ...(status === OrderStatus.DELIVERED
              ? { deliveredById: user.id, deliveredAt: new Date() }
              : {}),
          },
        });

        if (moved.count === 0) {
          throw new ProblemException(
            Problems.conflict,
            'The order changed status while the request was running. Read it again.',
          );
        }

        if (releasesStock(status)) {
          await releaseReservations(tx, order.items);
        }

        await recordStatus(tx, order.id, status);
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
   * `order-already-pending` says, and the only 409 of the seven carrying an
   * extension: the client needs the expiry to choose between waiting and
   * paying.
   *
   * An order that already expired is not a reason to refuse anyone — it is
   * work nobody did. It is cancelled here, inside the caller's transaction,
   * and its reservations go back before the new order takes any. Without
   * this a client is locked out of their own cart by an order that lapsed an
   * hour ago.
   *
   * The release is conditional on the cancellation having moved the row, and
   * that is not defensive noise: the sweep cancels expired orders too, so
   * from block 4 onwards there are two writers for this transition. Whoever
   * loses the race must give nothing back, or the same units are returned
   * twice and the store invents stock it does not have. Only the writer that
   * actually moved PENDING away from the row owns its reservations.
   */
  private async settlePendingOrder(
    tx: Tx,
    user: AuthenticatedUser,
  ): Promise<void> {
    const pending = await tx.order.findFirst({
      where: {
        AND: [this.scope(user, 'read'), { status: OrderStatus.PENDING }],
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!pending) return;

    // A PENDING order with no expiry is a row we should never have written.
    // Treating it as live is the safe reading: releasing stock we cannot
    // prove is stale would oversell.
    const lapsed =
      pending.expiresAt !== null && pending.expiresAt <= new Date();

    if (!lapsed) {
      throw new ProblemException(
        Problems.orderAlreadyPending,
        'Pay the pending order or wait for it to expire.',
        { expiresAt: pending.expiresAt?.toISOString() ?? null },
      );
    }

    const cancelled = await tx.order.updateMany({
      where: { id: pending.id, status: OrderStatus.PENDING },
      data: { status: OrderStatus.CANCELLED, expiresAt: null },
    });

    // Somebody else got there first — the sweep, or another checkout. They
    // released what this order was holding, so releasing it again would
    // hand the same units back twice.
    if (cancelled.count === 0) return;

    await releaseReservations(tx, pending.items);
    await recordStatus(tx, pending.id, OrderStatus.CANCELLED);
  }

  private async loadCheckoutableCart(
    tx: Tx,
    user: AuthenticatedUser,
  ): Promise<CartWithLines> {
    const cart = await tx.cart.findFirst({
      where: {
        AND: [
          accessibleBy(this.abilities.createForUser(user), 'read').ofType(
            'Cart',
          ),
          { status: CartStatus.ACTIVE },
        ],
      },
      include: { items: { include: { sku: true } } },
    });

    if (!cart || cart.items.length === 0) {
      throw new ProblemException(
        Problems.cartNotCheckoutable,
        'The cart is empty.',
      );
    }

    return cart;
  }

  private async placeOrder(
    tx: Tx,
    user: AuthenticatedUser,
    cart: CartWithLines,
    dto: CheckoutDto,
  ): Promise<PlacedOrder> {
    const orderId = newId();
    const lines: Prisma.OrderItemCreateWithoutOrderInput[] = [];
    let subtotal = 0;

    for (const line of cart.items) {
      // Re-read the SKU *and its product* inside the transaction. The cart
      // was filled at some point in the past, so its copy of both is stale;
      // checking availability against a fresh row and withdrawal against the
      // old one would leave the exact gap this re-read exists to close.
      const sku = await loadOrThrow(
        () =>
          tx.sku.findUnique({
            where: { id: line.skuId },
            include: { product: true },
          }),
        'A cart line refers to a SKU that no longer exists.',
        Problems.itemWithdrawn,
      );

      if (sku.product.deletedAt || !sku.product.isActive) {
        throw new ProblemException(
          Problems.itemWithdrawn,
          `${sku.product.name} is no longer for sale.`,
        );
      }

      const available = availableOf(sku);
      if (line.quantity > available) {
        throw new ProblemException(
          Problems.stockUnavailable,
          `Only ${available} unit(s) of ${sku.product.name} are available.`,
        );
      }

      await tx.sku.update({
        where: { id: sku.id },
        data: { reserved: { increment: line.quantity } },
      });

      subtotal += sku.price * line.quantity;

      lines.push({
        id: newId(),
        sku: { connect: { id: sku.id } },
        // Frozen here, on purpose: this is what makes the history survive a
        // rename, a price change or a product taken off sale.
        productName: sku.product.name,
        unitPrice: sku.price,
        quantity: line.quantity,
      });
    }

    // The lines are nested in the parent's create rather than written first:
    // `OrderItem.orderId` references `Order.id`, so an item inserted before
    // its order violates the foreign key.
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
        items: { create: lines },
      },
    });

    await recordStatus(tx, orderId, OrderStatus.PENDING);

    // The cart is spent. `status` is in the `where` and not only in the
    // data: it is the precondition that makes two overlapping checkouts
    // impossible to settle from the same cart. Clearing the mirror column is
    // what frees the user to start another one, since uq_carts_user_active
    // is a plain unique on a nullable column.
    const spent = await tx.cart.updateMany({
      where: { id: cart.id, status: CartStatus.ACTIVE },
      data: { status: CartStatus.CHECKED_OUT, activeUserId: null },
    });

    if (spent.count === 0) {
      throw new ProblemException(
        Problems.cartNotCheckoutable,
        'The cart was checked out while the request was running.',
      );
    }

    return { id: orderId, total: subtotal };
  }
}

type CartWithLines = Prisma.CartGetPayload<{
  include: { items: { include: { sku: true } } };
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
