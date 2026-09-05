import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { newId } from '../../common/ids';
import type { StockNotificationDispatcher } from '../../notifications/stock-notification.dispatcher';
import type {
  StockNotificationJobData,
  StockNotificationOutcome,
} from '../../notifications/stock-notification.jobs';
import { JobName } from '../queue.constants';
import { StockNotificationProcessor } from './stock-notification.processor';

/** The dispatcher is a double: what is under test here is the queue's edge. */
export const dispatcher = { dispatch: jest.fn() };

export const buildProcessor = (): StockNotificationProcessor =>
  new StockNotificationProcessor(
    dispatcher as unknown as StockNotificationDispatcher,
  );

export const theSkuId = newId();

export const aJob = (
  name: string,
  data: Partial<StockNotificationJobData> = {},
  attemptsMade = 3,
): Job<StockNotificationJobData> =>
  ({
    name,
    attemptsMade,
    data: { skuId: theSkuId, restockCycle: 0, ...data },
  }) as Job<StockNotificationJobData>;

/** The job this queue actually carries. */
export const aNotifyJob = (
  data: Partial<StockNotificationJobData> = {},
  attemptsMade = 3,
): Job<StockNotificationJobData> =>
  aJob(JobName.NotifyLowStock, data, attemptsMade);

export const anOutcome = (
  overrides: Partial<StockNotificationOutcome> = {},
): StockNotificationOutcome => ({
  candidates: 2,
  notified: 2,
  skipped: 0,
  failed: 0,
  withImage: true,
  ...overrides,
});

/**
 * The consumer's edge, and only its edge.
 *
 * Everything the notification decides is tested against
 * `StockNotificationDispatcher` with no queue in sight; what is left here is
 * the contract with BullMQ, which is three things and each of them has bitten
 * this repository already.
 *
 * **The unknown name throws.** A queue that returns quietly on a name it does
 * not recognise is how a renamed job stops running while every dashboard
 * still reports the queue as healthy — the same sentence the maintenance
 * processor's spec makes, for the same reason.
 *
 * **The failure log is the diagnosis.** `STOCK_NOTIFICATION_JOB_OPTIONS`
 * removes a failed job, so a crossing that went unannounced leaves this line
 * and nothing else. It may name the sku and the cycle: they identify what
 * failed and neither is personal data. What it must never grow is a
 * recipient — the addresses this job produces travel in the *mail* jobs it
 * enqueues, and `MAIL_JOB_OPTIONS` exists because those must not be written
 * down.
 *
 * **The job may be missing.** BullMQ types it optional, and this queue's own
 * `removeOnFail: true` is what makes that happen: a stalled job is moved to
 * the failed set and deleted in the same breath. Dereferencing it would
 * throw inside the listener and take the only record of the failure with it.
 */
describe('StockNotificationProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dispatcher.dispatch.mockResolvedValue(anOutcome());
  });

  describe('the job it accepts', () => {
    it('hands a NotifyLowStock job straight to the dispatcher', async () => {
      const job = aNotifyJob();

      await buildProcessor().process(job);

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(job.data);
    });

    it('passes the payload through unchanged, sku and cycle both', async () => {
      const job = aNotifyJob({ skuId: theSkuId, restockCycle: 7 });

      await buildProcessor().process(job);

      expect(dispatcher.dispatch).toHaveBeenCalledWith({
        skuId: theSkuId,
        restockCycle: 7,
      });
    });

    it('returns the dispatcher outcome, so the queue records the counts', async () => {
      const outcome = anOutcome({ candidates: 5, notified: 4, skipped: 1 });
      dispatcher.dispatch.mockResolvedValue(outcome);

      await expect(buildProcessor().process(aNotifyJob())).resolves.toBe(
        outcome,
      );
    });

    it('throws on a job name it does not recognise, naming the name it got', async () => {
      await expect(
        buildProcessor().process(aJob('sweep-something-else')),
      ).rejects.toThrow('Unknown stock notification job: sweep-something-else');
    });

    it('dispatches nothing for a job name it does not recognise', async () => {
      await expect(
        buildProcessor().process(aJob('sweep-something-else')),
      ).rejects.toThrow();

      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('lets a dispatcher failure escape, so the job retries rather than reporting success', async () => {
      dispatcher.dispatch.mockRejectedValue(new Error('Postgres is away'));

      await expect(buildProcessor().process(aNotifyJob())).rejects.toThrow(
        'Postgres is away',
      );
    });
  });

  describe('the failure log, which is all a discarded job leaves', () => {
    /** The listener writes through `Logger.prototype.error`, as the mail one does. */
    const captureError = () =>
      jest.spyOn(Logger.prototype, 'error').mockImplementation();

    it('names the sku and the cycle that failed', () => {
      const log = captureError();

      buildProcessor().onFailed(
        aNotifyJob({ skuId: theSkuId, restockCycle: 4 }),
        new Error('Postgres is away'),
      );

      expect(String(log.mock.calls[0]?.[0])).toContain(
        `Sku ${theSkuId} (cycle 4)`,
      );
      log.mockRestore();
    });

    it('says how many attempts had been made', () => {
      const log = captureError();

      buildProcessor().onFailed(aNotifyJob({}, 7), new Error('timeout'));

      expect(String(log.mock.calls[0]?.[0])).toContain('after 7 attempt(s)');
      log.mockRestore();
    });

    it('carries the error message and its stack', () => {
      const log = captureError();
      const error = new Error('S3 refused the read');

      buildProcessor().onFailed(aNotifyJob(), error);

      expect(String(log.mock.calls[0]?.[0])).toContain('S3 refused the read');
      expect(log.mock.calls[0]?.[1]).toBe(error.stack);
      log.mockRestore();
    });

    /**
     * The payload holds two identifiers and no address, and the assertion is
     * that the address a plausible future refactor would reach for — the
     * recipient of the mail jobs this run enqueues — is absent from the line
     * rather than merely that a line was written.
     */
    it('writes no recipient address, which this payload never held', () => {
      const log = captureError();

      buildProcessor().onFailed(
        aNotifyJob(),
        new Error('the mail queue refused the job'),
      );

      const written = log.mock.calls.flat().map(String).join(' ');
      expect(written).not.toContain('@');
      expect(written).toContain(theSkuId);
    });

    it('still logs when the job was removed before the event arrived', () => {
      const log = captureError();

      expect(() =>
        buildProcessor().onFailed(undefined, new Error('stalled')),
      ).not.toThrow();

      expect(String(log.mock.calls[0]?.[0])).toContain('stalled');
      expect(String(log.mock.calls[0]?.[0])).toContain('after 0 attempt(s)');
      log.mockRestore();
    });

    it('says which sku is unknown rather than inventing one', () => {
      const log = captureError();

      buildProcessor().onFailed(undefined, new Error('stalled'));

      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain('A removed stock notification job');
      expect(line).not.toContain(theSkuId);
      log.mockRestore();
    });
  });
});
