import { Injectable, Logger } from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';

/** How many pending confirmations one drain run will retry. */
export const CONFIRMATION_OUTBOX_BATCH_SIZE = 100;

export interface ConfirmationOutboxDrainOutcome {
  /** Rows this run looked at. */
  examined: number;
  /** How many it actually enqueued. */
  sent: number;
  /** How many it could not enqueue, and left PENDING for the next run. */
  failed: number;
}

/**
 * The independent retry `SettlementService.pay` cannot give the confirmation
 * itself.
 *
 * `SettlementService.confirm` makes the first attempt right after its
 * transaction commits, and it must never fail the settlement job over a
 * mail queue outage — the money has already moved, and a retried job would
 * only re-read an order that is no longer PENDING and settle nothing. So a
 * rejected enqueue there is swallowed and logged, and the row `pay` wrote in
 * the same transaction as the order is what is left owing a confirmation.
 * This service is what comes back for it, on its own schedule, independent
 * of whether the process that tried first is even the one running now.
 *
 * It batches and re-reads for the same reason `OrdersSweepService` does:
 * whatever a bounded run does not reach is still PENDING a minute later, and
 * the next run continues from the oldest row rather than starving a backlog
 * forever.
 */
@Injectable()
export class OrderConfirmationOutboxService {
  private readonly logger = new Logger(OrderConfirmationOutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async drain(): Promise<ConfirmationOutboxDrainOutcome> {
    const pending = await this.prisma.orderConfirmationOutbox.findMany({
      where: { status: NotificationStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: CONFIRMATION_OUTBOX_BATCH_SIZE,
    });

    let sent = 0;
    let failed = 0;

    for (const row of pending) {
      try {
        await this.mail.sendOrderConfirmation(row.email, row.orderId);
        await this.prisma.orderConfirmationOutbox.updateMany({
          where: { id: row.id, status: NotificationStatus.PENDING },
          data: { status: NotificationStatus.SENT, sentAt: new Date() },
        });
        sent += 1;
      } catch (error) {
        // The row stays PENDING — that is what makes the next run retry it
        // — and `attempts` is bumped only so a row stuck across many runs is
        // visible to whoever monitors this queue, the same role it plays on
        // `StockNotification`.
        failed += 1;
        await this.prisma.orderConfirmationOutbox.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 } },
        });
        this.logger.error(
          `Could not resend the confirmation for order ${row.orderId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Only when it did something: this runs 1,440 times a day and a line
    // per run would bury everything else in the worker's output.
    if (sent > 0 || failed > 0) {
      this.logger.log(
        `Drained ${pending.length} pending confirmation(s): ${sent} sent, ${failed} failed.`,
      );
    }

    return { examined: pending.length, sent, failed };
  }
}
