import { Logger } from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { resetPrismaMock } from '../../testing/prisma.mock';
import {
  CONFIRMATION_OUTBOX_BATCH_SIZE,
  OrderConfirmationOutboxService,
} from './order-confirmation-outbox.service';

/* Jest's asymmetric matchers are typed as `any`; these are partial checks of
 * Prisma calls and are never values passed to production code. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/** A row this service would find still owing a confirmation. */
export const aPendingOutboxRow = (
  overrides: {
    id?: string;
    orderId?: string;
    email?: string;
    attempts?: number;
  } = {},
) => ({
  id: overrides.id ?? '018f3b6f-0000-7000-8000-000000000099',
  orderId: overrides.orderId ?? '018f3b6f-0000-7000-8000-000000000001',
  email: overrides.email ?? 'buyer@example.com',
  status: NotificationStatus.PENDING,
  attempts: overrides.attempts ?? 0,
  sentAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
});

/**
 * The scheduled retry `settlement.service.spec.ts` documents but cannot
 * exercise itself, since `SettlementService.confirm` never drains anything —
 * it only writes and reads the one row its own transaction created. This is
 * the other half: given whatever is still PENDING, does a run send it, mark
 * it, and leave alone what it could not.
 *
 * Every case here began as a stub, and the assertions were written by this
 * repository's author rather than by the hand that wrote the drain — which
 * is what CLAUDE.md reserves them for. They assert the Prisma calls a drain
 * actually makes, not what a mock happens to return.
 */
describe('OrderConfirmationOutboxService', () => {
  let h: ServiceHarness<OrderConfirmationOutboxService>;

  beforeEach(async () => {
    h = await buildService(OrderConfirmationOutboxService);
    resetPrismaMock(h.prisma);

    h.prisma.orderConfirmationOutbox.findMany.mockResolvedValue([]);
  });

  it('reads only rows in NotificationStatus.PENDING, oldest first', async () => {
    await h.service.drain();

    expect(h.prisma.orderConfirmationOutbox.findMany).toHaveBeenCalledWith({
      where: { status: NotificationStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: CONFIRMATION_OUTBOX_BATCH_SIZE,
    });
  });

  it('bounds one run to CONFIRMATION_OUTBOX_BATCH_SIZE rows, like the sweep bounds its own batch', async () => {
    await h.service.drain();

    expect(h.prisma.orderConfirmationOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: CONFIRMATION_OUTBOX_BATCH_SIZE }),
    );
  });

  it("sends the confirmation to each pending row's own email and order id", async () => {
    const first = aPendingOutboxRow({
      id: '018f3b6f-0000-7000-8000-000000000101',
      orderId: '018f3b6f-0000-7000-8000-000000000011',
      email: 'first@example.com',
    });
    const second = aPendingOutboxRow({
      id: '018f3b6f-0000-7000-8000-000000000102',
      orderId: '018f3b6f-0000-7000-8000-000000000012',
      email: 'second@example.com',
    });
    h.prisma.orderConfirmationOutbox.findMany.mockResolvedValue([
      first,
      second,
    ]);

    await h.service.drain();

    expect(h.mail.sendOrderConfirmation).toHaveBeenNthCalledWith(
      1,
      first.email,
      first.orderId,
    );
    expect(h.mail.sendOrderConfirmation).toHaveBeenNthCalledWith(
      2,
      second.email,
      second.orderId,
    );
  });

  it('marks a row SENT with a sentAt once its confirmation was actually enqueued', async () => {
    const row = aPendingOutboxRow();

    h.prisma.orderConfirmationOutbox.findMany.mockResolvedValue([row]);
    await h.service.drain();

    expect(h.prisma.orderConfirmationOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, status: NotificationStatus.PENDING },
      data: { status: NotificationStatus.SENT, sentAt: expect.any(Date) },
    });
    expect(
      h.prisma.orderConfirmationOutbox.updateMany.mock.invocationCallOrder[0],
    ).toBeGreaterThan(h.mail.sendOrderConfirmation.mock.invocationCallOrder[0]);
  });

  it('leaves a row PENDING and increments its attempts when the enqueue rejects', async () => {
    const row = aPendingOutboxRow({ attempts: 2 });
    h.prisma.orderConfirmationOutbox.findMany.mockResolvedValue([row]);
    h.mail.sendOrderConfirmation.mockRejectedValueOnce(
      new Error('mail queue unavailable'),
    );

    await expect(h.service.drain()).resolves.toEqual({
      examined: 1,
      sent: 0,
      failed: 1,
    });

    expect(h.prisma.orderConfirmationOutbox.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    expect(h.prisma.orderConfirmationOutbox.updateMany).not.toHaveBeenCalled();
  });

  it('keeps draining the rest of the batch after one row fails to enqueue', async () => {
    const failed = aPendingOutboxRow({
      id: '018f3b6f-0000-7000-8000-000000000101',
    });
    const sent = aPendingOutboxRow({
      id: '018f3b6f-0000-7000-8000-000000000102',
    });
    h.prisma.orderConfirmationOutbox.findMany.mockResolvedValue([failed, sent]);
    h.mail.sendOrderConfirmation
      .mockRejectedValueOnce(new Error('mail queue unavailable'))
      .mockResolvedValueOnce(undefined);

    await h.service.drain();

    expect(h.mail.sendOrderConfirmation).toHaveBeenCalledTimes(2);
    expect(h.prisma.orderConfirmationOutbox.update).toHaveBeenCalledWith({
      where: { id: failed.id },
      data: { attempts: { increment: 1 } },
    });
    expect(h.prisma.orderConfirmationOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: sent.id, status: NotificationStatus.PENDING },
      data: { status: NotificationStatus.SENT, sentAt: expect.any(Date) },
    });
  });

  it('reports examined, sent and failed counts that add up to what the run actually did', async () => {
    const sent = aPendingOutboxRow({
      id: '018f3b6f-0000-7000-8000-000000000101',
    });
    const failed = aPendingOutboxRow({
      id: '018f3b6f-0000-7000-8000-000000000102',
    });
    h.prisma.orderConfirmationOutbox.findMany.mockResolvedValue([sent, failed]);
    h.mail.sendOrderConfirmation
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('mail queue unavailable'));

    await expect(h.service.drain()).resolves.toEqual({
      examined: 2,
      sent: 1,
      failed: 1,
    });
  });

  it('does nothing, and logs nothing, when no row is PENDING', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(h.service.drain()).resolves.toEqual({
      examined: 0,
      sent: 0,
      failed: 0,
    });

    expect(h.mail.sendOrderConfirmation).not.toHaveBeenCalled();
    expect(h.prisma.orderConfirmationOutbox.update).not.toHaveBeenCalled();
    expect(h.prisma.orderConfirmationOutbox.updateMany).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});
