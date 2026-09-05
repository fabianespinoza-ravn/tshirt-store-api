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
  /** Seen before. Nothing was written and nothing was queued. */
  Replay = 'replay',
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
    const webhookEventId = newId();

    if (!(await this.record(event, webhookEventId))) {
      // The retry the sequence diagram describes: it collided with the
      // unique constraint, so nothing was applied a second time and Stripe
      // gets its acknowledgement.
      this.logger.log(`Stripe event ${event.id} was already recorded.`);
      return WebhookOutcome.Replay;
    }

    const job = settlementJobFor(event, webhookEventId);

    if (!job) return WebhookOutcome.Recorded;

    // The queue is asked after the row exists, and a failure here is
    // deliberately not swallowed: the caller answers 500, Stripe redelivers,
    // and the redelivery collides with the row this call just wrote. What is
    // left is a recorded event that never became a job, which is precisely
    // what the "recorded but not settled for more than N minutes" alert in
    // `docs/ARQUITECTURA.md` exists to catch. The alert is the backstop, not
    // an afterthought: no ordering of these two writes removes the window,
    // because Redis and Postgres do not share a transaction.
    await this.settlement.add(JobName.SettlePayment, job, {
      // Same delivery, same job. BullMQ drops a duplicate id while the job
      // still exists, which is a second line of defence in front of the
      // constraint above — never a replacement for it, since a completed job
      // is eventually trimmed and a webhook can be replayed for three days.
      jobId: event.id,
    });

    return WebhookOutcome.Queued;
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
   * Writes the event down, and answers whether this call is the one that
   * did it.
   *
   * `false` is a duplicate delivery. The idempotency lives in the unique
   * index on `stripe_event_id` rather than in a read-then-write here, and
   * the difference is the point: two deliveries of the same event arriving
   * together would both pass a check, and only one can win an insert.
   *
   * Only P2002 is caught. Catching more would turn a database that is down
   * into an acknowledgement Stripe never redelivers, and that is a payment
   * lost quietly. The table carries exactly one unique constraint, so a
   * P2002 on it can only be this one.
   */
  private async record(
    event: Stripe.Event,
    webhookEventId: string,
  ): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          id: webhookEventId,
          stripeEventId: event.id,
          eventType: event.type,
          // The verified event, whole. It is the only copy of what Stripe
          // actually said, and the worker reads its own facts from the job
          // rather than from here — but an argument about a settlement six
          // months from now is answered by this column and by nothing else.
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });

      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        return false;
      }

      throw error;
    }
  }
}
