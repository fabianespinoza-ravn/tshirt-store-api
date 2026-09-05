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
    it.todo(`settles a ${JobName.SettlePayment} job`);
    it.todo('passes the job data through to the service unchanged');
    it.todo('returns the outcome the service reported, unchanged');
    it.todo(
      'throws on a job name it does not recognise, rather than ignoring it',
    );
    it.todo(
      'names the unrecognised job in the error, so the failed entry says what it was',
    );
    it.todo('settles nothing when the name did not match');
  });

  describe('the failure log', () => {
    it.todo('names the stripe event, the order and the attempt count');
    it.todo('keeps the stack, because a settlement failure is investigated');
    it.todo('still logs when the job was removed before the event arrived');
  });
});
