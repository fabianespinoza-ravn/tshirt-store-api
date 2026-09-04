import { newId } from '../common/ids';
import type { OrderStatus, Prisma } from '@prisma/client';

/**
 * The two writes that follow an order leaving a status, shared by the two
 * things that can move one: a request, through `OrdersService`, and the
 * sweep, which has no caller at all.
 *
 * They are free functions taking the transaction client rather than methods,
 * because the sweep must not depend on `OrdersService` — that service is
 * built around an authenticated user and a row scope, and the sweep is a
 * system actor with neither. Duplicating them instead would leave two places
 * that must agree about how a reservation is returned.
 */

/**
 * Gives an order's units back to the shelf.
 *
 * The caller decides *whether* to call this; getting that wrong is how the
 * same units are returned twice. Only whoever actually moved the order out
 * of the status that held them owns them.
 */
export async function releaseReservations(
  tx: Prisma.TransactionClient,
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
 * Appends the status an order has just taken. `sequence` is unique per
 * order, so the next one is however many rows are already there — counted
 * inside the transaction, where that number cannot move underneath.
 */
export async function recordStatus(
  tx: Prisma.TransactionClient,
  orderId: string,
  status: OrderStatus,
): Promise<void> {
  const sequence = await tx.orderStatusHistory.count({ where: { orderId } });

  await tx.orderStatusHistory.create({
    data: { id: newId(), orderId, status, sequence },
  });
}
