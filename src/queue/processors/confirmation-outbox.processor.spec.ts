import type { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
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

const { processor, outbox } = buildProcessor();

/**
 * The processor holds no logic of its own — `SettlementProcessor.spec.ts`
 * makes the same case for its own thin consumer, and the reasoning carries
 * over unchanged. What is new here is the drain it calls into, and that
 * behaviour is this session's to scaffold and the student's to assert.
 */
describe('ConfirmationOutboxProcessor', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('the job it answers to', () => {
    it('drains the outbox on a drain-confirmation-outbox job', async () => {
      await processor.process(aJob(JobName.DrainConfirmationOutbox));

      expect(outbox.drain).toHaveBeenCalledWith();
    });

    it('returns the outcome the drain reported, unchanged', async () => {
      const outcome = { examined: 2, sent: 1, failed: 1 };
      outbox.drain.mockResolvedValue(outcome);

      await expect(
        processor.process(aJob(JobName.DrainConfirmationOutbox)),
      ).resolves.toBe(outcome);
    });

    it('throws on a job name it does not recognise, rather than ignoring it', async () => {
      await expect(processor.process(aJob('renamed-job'))).rejects.toThrow();
    });

    it('names the unrecognised job in the error', async () => {
      await expect(processor.process(aJob('renamed-job'))).rejects.toThrow(
        'Unknown confirmation outbox job: renamed-job',
      );
    });

    it('drains nothing when the name did not match', async () => {
      await expect(processor.process(aJob('renamed-job'))).rejects.toThrow();

      expect(outbox.drain).not.toHaveBeenCalled();
    });
  });

  describe('the failure log', () => {
    it('names the job and the error when a run fails', () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const error = new Error('the database was unreachable');

      processor.onFailed(aJob(JobName.DrainConfirmationOutbox), error);

      expect(log).toHaveBeenCalledWith(
        'drain-confirmation-outbox failed: the database was unreachable',
        error.stack,
      );
      log.mockRestore();
    });

    it('keeps the stack, because a stuck drain is investigated', () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const error = new Error('the database was unreachable');

      processor.onFailed(aJob(JobName.DrainConfirmationOutbox), error);

      expect(log).toHaveBeenCalledWith(expect.any(String), error.stack);
      log.mockRestore();
    });

    it('still logs when the job was removed before the event arrived', () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      expect(() =>
        processor.onFailed(undefined, new Error('stalled')),
      ).not.toThrow();
      expect(String(log.mock.calls[0]?.[0])).toContain('stalled');
      log.mockRestore();
    });
  });
});
