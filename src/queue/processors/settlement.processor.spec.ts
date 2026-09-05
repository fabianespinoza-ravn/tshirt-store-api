import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SettlementEventType } from '../../payments/webhooks/settlement.jobs';
import type { SettlementJobData } from '../../payments/webhooks/settlement.jobs';
import {
  SettlementOutcome,
  type SettlementService,
} from '../../payments/webhooks/settlement.service';
import { JobName } from '../queue.constants';
import { SettlementProcessor } from './settlement.processor';

/** The processor with its one dependency doubled, and the double returned. */
export const buildProcessor = () => {
  const settlement = {
    settle: jest.fn().mockResolvedValue(SettlementOutcome.Paid),
  };

  return {
    processor: new SettlementProcessor(
      settlement as unknown as SettlementService,
    ),
    settlement,
  };
};

/** A queued job, as BullMQ delivers it: a name, a payload, an attempt count. */
export const aJob = (
  name: string,
  overrides: Partial<SettlementJobData> = {},
  attemptsMade = 1,
): Job<SettlementJobData> =>
  ({
    name,
    attemptsMade,
    data: {
      webhookEventId: '018f3b6f-0000-7000-8000-000000000010',
      stripeEventId: 'evt_delivered_once',
      eventType: SettlementEventType.PaymentIntentSucceeded,
      paymentIntentId: 'pi_settled_by_the_suite',
      orderId: '018f3b6f-0000-7000-8000-000000000001',
      ...overrides,
    },
  }) as Job<SettlementJobData>;

/**
 * The processor holds no logic, so most of this file is about the two things
 * a thin consumer can still get wrong.
 *
 * **An unrecognised job name has to throw.** The maintenance processor makes
 * the argument and it is sharper here: a settlement queue that silently
 * ignores a renamed job stops applying payments while every dashboard reads
 * healthy and empty. `removeOnFail: false` keeps the thrown job where a
 * person can find it.
 *
 * **The failure log has to name the payment.** This is the one queue that
 * keeps its failures, and the line is what turns "a job failed" into "this
 * Stripe event, for this order, has not settled". The payload is
 * identifiers only, which is what makes logging them safe — a mail job's
 * payload could not be logged this way and its processor says so.
 */
describe('SettlementProcessor', () => {
  describe('the job it answers to', () => {
    it(`settles a ${JobName.SettlePayment} job`, async () => {
      const { processor, settlement } = buildProcessor();

      await expect(
        processor.process(aJob(JobName.SettlePayment)),
      ).resolves.toBe(SettlementOutcome.Paid);
      expect(settlement.settle).toHaveBeenCalledTimes(1);
    });

    it('passes the job data through to the service unchanged', async () => {
      const { processor, settlement } = buildProcessor();
      const job = aJob(JobName.SettlePayment, {
        stripeEventId: 'evt_carried_through',
        orderId: '018f3b6f-0000-7000-8000-0000000000aa',
      });

      await processor.process(job);

      // Exact equality rather than `objectContaining`: the payload is five
      // identifiers, and a processor that dropped one or invented one is the
      // failure worth catching.
      expect(settlement.settle).toHaveBeenCalledWith(job.data);
    });

    it('returns the outcome the service reported, unchanged', async () => {
      const { processor, settlement } = buildProcessor();
      // Deliberately not the builder's default: an assertion against `Paid`
      // would hold for a processor that answered with a constant.
      settlement.settle.mockResolvedValue(SettlementOutcome.Refunded);

      await expect(
        processor.process(aJob(JobName.SettlePayment)),
      ).resolves.toBe(SettlementOutcome.Refunded);
    });

    it('throws on a job name it does not recognise, rather than ignoring it', async () => {
      const { processor } = buildProcessor();

      await expect(processor.process(aJob('renamed-job'))).rejects.toThrow(
        Error,
      );
    });

    it('names the unrecognised job in the error, so the failed entry says what it was', async () => {
      const { processor } = buildProcessor();

      await expect(processor.process(aJob('renamed-job'))).rejects.toThrow(
        'Unknown settlement job: renamed-job',
      );
    });

    it('settles nothing when the name did not match', async () => {
      const { processor, settlement } = buildProcessor();

      await expect(processor.process(aJob('renamed-job'))).rejects.toThrow();

      expect(settlement.settle).not.toHaveBeenCalled();
    });
  });

  describe('the failure log', () => {
    it('names the stripe event, the order and the attempt count', () => {
      const { processor } = buildProcessor();
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const job = aJob(
        JobName.SettlePayment,
        {
          stripeEventId: 'evt_that_would_not_settle',
          orderId: '018f3b6f-0000-7000-8000-0000000000bb',
        },
        7,
      );
      const error = new Error('the database was unreachable');

      processor.onFailed(job, error);

      expect(log).toHaveBeenCalledWith(
        'Settlement of Stripe event evt_that_would_not_settle for order 018f3b6f-0000-7000-8000-0000000000bb failed after 7 attempt(s): the database was unreachable',
        error.stack,
      );
      log.mockRestore();
    });

    it('keeps the stack, because a settlement failure is investigated', () => {
      const { processor } = buildProcessor();
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const error = new Error('the database was unreachable');

      processor.onFailed(aJob(JobName.SettlePayment), error);

      const stack: unknown = log.mock.calls[0]?.[1];
      expect(typeof stack).toBe('string');
      expect(stack).toBe(error.stack);
      log.mockRestore();
    });

    /**
     * BullMQ types the listener's job as optional, for an event delivered
     * after its job was removed. A processor that dereferenced it anyway
     * would throw inside the listener and leave the failure with no record
     * at all — the silence this log exists to prevent.
     */
    it('still logs when the job was removed before the event arrived', () => {
      const { processor } = buildProcessor();
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const error = new Error('stalled');

      expect(() => processor.onFailed(undefined, error)).not.toThrow();

      expect(log).toHaveBeenCalledWith(
        'A settlement job failed and was already removed, so the payment it carried is unknown: stalled',
        error.stack,
      );
      log.mockRestore();
    });
  });
});
