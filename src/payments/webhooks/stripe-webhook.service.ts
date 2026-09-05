import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import Stripe from 'stripe';
import { newId } from '../../common/ids';
import { Problems } from '../../common/problem/problem.catalog';
import { ProblemException } from '../../common/problem/problem.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { JobName, QueueName } from '../../queue/queue.constants';
import { StripeService } from '../stripe.service';
import { settlementJobFor, type SettlementJobData } from './settlement.jobs';

/** Prisma's unique-constraint violation, which is the whole of the idempotency. */
const UNIQUE_VIOLATION = 'P2002';

/** What a delivery did, for the log line and for the tests that pin it. */
export enum WebhookOutcome {
  /** Recorded and queued for settlement. */
  Queued = 'queued',
  /** Recorded; this API settles nothing for that event type. */
  Recorded = 'recorded',
  /** Seen before and already settled. Nothing was written, nothing was queued. */
  Replay = 'replay',
  /** Seen before but never settled: the job was asked for again. */
  Requeued = 'requeued',
}

/** The recorded event a delivery corresponds to, however it got there. */
interface RecordedEvent {
  /** The `webhook_events` row's id, which the settlement job stamps. */
  id: string;
  /** Null until the worker has settled it. */
  processedAt: Date | null;
  /** Whether this call is the one that wrote the row. */
  fresh: boolean;
}

/**
 * Verify, record, enqueue, acknowledge — and settle nothing.
 *
 * The order of those four is the design and not an implementation detail.
 * Stripe waits for this response and retries for three days if it does not
 * get one, so whatever happens here has to be short and has to survive being
 * run again on the same event. Moving the order, decrementing stock and
 * refunding all take longer than a webhook should hold and all move money,
 * so they belong to the worker, behind a queue that persists the job before
 * anything runs. The visible consequence is that an order can read PENDING
 * for a moment after its payment succeeded, which `docs/ARQUITECTURA.md`
 * states outright rather than treating as a defect.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    @InjectQueue(QueueName.Settlement)
    private readonly settlement: Queue<SettlementJobData>,
  ) {}

  async receive(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<WebhookOutcome> {
    const event = this.verify(rawBody, signature);
    const recorded = await this.record(event);
    const job = settlementJobFor(event, recorded.id);

    if (!job) {
      return recorded.fresh ? WebhookOutcome.Recorded : WebhookOutcome.Replay;
    }

    // A delivery already settled is the replay the sequence diagram
    // describes: it collided with the unique constraint, nothing was applied
    // a second time, and Stripe gets its acknowledgement.
    if (!recorded.fresh && recorded.processedAt !== null) {
      this.logger.log(`Stripe event ${event.id} was already settled.`);
      return WebhookOutcome.Replay;
    }

    // Redis and Postgres do not share a transaction, so there is a window
    // where the row exists and the job does not — a failed `add`, or a
    // process that died between the two. **Stripe's own retry is what closes
    // it**, and only because this asks again for a recorded event that was
    // never settled. Answering 200 to that redelivery and stopping would end
    // the three days of retries with a charge taken, an order still PENDING
    // and its units reserved against everybody else forever.
    //
    // Nothing is applied twice by asking. The job id below collapses a
    // duplicate onto the job that already exists, and the settlement itself
    // repeats every precondition in the `where` of its writes, so a job that
    // does run a second time moves no row a second time.
    await this.settlement.add(JobName.SettlePayment, job, {
      // Same delivery, same job. This is a convenience in front of the
      // constraint above and never a replacement for it: a completed job is
      // eventually trimmed, and a webhook can be replayed for three days.
      jobId: event.id,
    });

    if (recorded.fresh) return WebhookOutcome.Queued;

    this.logger.warn(
      `Stripe event ${event.id} was recorded but never settled; its job was asked for again.`,
    );

    return WebhookOutcome.Requeued;
  }

  /**
   * The signature check, and the two ways it can be impossible.
   *
   * A missing raw body is **ours**: it means the application was built
   * without `rawBody: true`, so no signature could ever verify. Serving that
   * as a 400 would blame Stripe for our own bootstrap, so it is a 500.
   *
   * A missing or wrong signature is the caller's, and this is the one place
   * in the whole integration where an upstream failure is honestly a 4xx of
   * ours: whoever posted the request really did send a header that does not
   * verify. `docs/AUTHORIZATION-MATRIX.md` lists this route as authenticated
   * by signature alone, so a failed verification is this route's 401 and 403
   * rolled into the 400 the contract declares.
   */
  private verify(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Stripe.Event {
    if (!rawBody) {
      this.logger.error(
        'The webhook route received no raw body: the application was created without rawBody, so no Stripe signature can verify.',
      );
      throw new ProblemException(
        Problems.internalError,
        'The request could not be verified.',
      );
    }

    if (!signature) {
      throw new ProblemException(
        Problems.validation,
        'The Stripe-Signature header is required.',
      );
    }

    try {
      return this.stripe.constructWebhookEvent(rawBody, signature);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        // The message names the reason — stale timestamp, wrong secret, a
        // body that was parsed before it got here — and it goes to the log
        // and not to the client: an endpoint that explained why a forgery
        // failed would be a tool for producing one that works.
        this.logger.warn(`Rejected a Stripe delivery: ${error.message}`);
        throw new ProblemException(
          Problems.validation,
          'The Stripe signature could not be verified.',
        );
      }

      throw error;
    }
  }

  /**
   * Writes the event down, and answers with the row a delivery corresponds
   * to — the one this call inserted, or the one that was already there.
   *
   * The idempotency lives in the unique index on `stripe_event_id` rather
   * than in a read-then-write, and the difference is the point: two
   * deliveries of the same event arriving together would both pass a check,
   * and only one can win an insert. The read below happens **after** the
   * insert has lost, so it is a lookup of a row that certainly exists rather
   * than a check that could race.
   *
   * The existing row's id, not the fresh uuid, is what comes back. A
   * settlement job stamps `processed_at` by id, and one carrying an id no
   * row has would settle the order and leave the event looking unhandled
   * forever.
   *
   * Only P2002 is caught. Catching more would turn a database that is down
   * into an acknowledgement Stripe never redelivers, and that is a payment
   * lost quietly. The table carries exactly one unique constraint, so a
   * P2002 on it can only be this one.
   */
  private async record(event: Stripe.Event): Promise<RecordedEvent> {
    const id = newId();

    try {
      await this.prisma.webhookEvent.create({
        data: {
          id,
          stripeEventId: event.id,
          eventType: event.type,
          // The verified event, whole. It is the only copy of what Stripe
          // actually said, and the worker reads its own facts from the job
          // rather than from here — but an argument about a settlement six
          // months from now is answered by this column and by nothing else.
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });

      return { id, processedAt: null, fresh: true };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== UNIQUE_VIOLATION
      ) {
        throw error;
      }

      const existing = await this.prisma.webhookEvent.findUnique({
        where: { stripeEventId: event.id },
        select: { id: true, processedAt: true },
      });

      if (!existing) {
        // The row that won the insert is gone again, which nothing in this
        // API does. Rethrowing keeps Stripe retrying rather than
        // acknowledging an event this call can no longer account for.
        throw error;
      }

      return { ...existing, fresh: false };
    }
  }
}
