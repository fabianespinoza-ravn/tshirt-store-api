import type { Job } from 'bullmq';
import type { ConfirmationOutboxDrainOutcome } from '../../payments/webhooks/order-confirmation-outbox.service';
import type { OrderConfirmationOutboxService } from '../../payments/webhooks/order-confirmation-outbox.service';
import { JobName } from '../queue.constants';
import { ConfirmationOutboxProcessor } from './confirmation-outbox.processor';

/** The processor with its one dependency doubled, and the double returned. */
export const buildProcessor = () => {
  const outcome: ConfirmationOutboxDrainOutcome = {
    examined: 0,
    sent: 0,
    failed: 0,
  };
  const outbox = {
    drain: jest.fn().mockResolvedValue(outcome),
  };

  return {
    processor: new ConfirmationOutboxProcessor(
      outbox as unknown as OrderConfirmationOutboxService,
    ),
    outbox,
  };
};

/** A queued job, as BullMQ delivers it: a name and an attempt count. */
export const aJob = (name: string, attemptsMade = 1): Job =>
  ({ name, attemptsMade }) as Job;

/**
 * The processor holds no logic of its own — `SettlementProcessor.spec.ts`
 * makes the same case for its own thin consumer, and the reasoning carries
 * over unchanged. What is new here is the drain it calls into, and that
 * behaviour is this session's to scaffold and the student's to assert.
 */
describe('ConfirmationOutboxProcessor', () => {
  describe('the job it answers to', () => {
    it.todo(`drains the outbox on a ${JobName.DrainConfirmationOutbox} job`);
    it.todo('returns the outcome the drain reported, unchanged');
    it.todo(
      'throws on a job name it does not recognise, rather than ignoring it',
    );
    it.todo('names the unrecognised job in the error');
    it.todo('drains nothing when the name did not match');
  });

  describe('the failure log', () => {
    it.todo('names the job and the error when a run fails');
    it.todo('keeps the stack, because a stuck drain is investigated');
    it.todo('still logs when the job was removed before the event arrived');
  });
});
