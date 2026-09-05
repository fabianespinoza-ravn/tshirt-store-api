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
  aJob(JobName.NotifyRestock, data, attemptsMade);

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
    it.todo('hands a NotifyRestock job straight to the dispatcher');

    it.todo('passes the payload through unchanged, sku and cycle both');

    it.todo('returns the dispatcher outcome, so the queue records the counts');

    it.todo(
      'throws on a job name it does not recognise, naming the name it got',
    );

    it.todo('dispatches nothing for a job name it does not recognise');

    it.todo(
      'lets a dispatcher failure escape, so the job retries rather than reporting success',
    );
  });

  describe('the failure log, which is all a discarded job leaves', () => {
    it.todo('names the sku and the cycle that failed');

    it.todo('says how many attempts had been made');

    it.todo('carries the error message and its stack');

    it.todo('writes no recipient address, which this payload never held');

    it.todo('still logs when the job was removed before the event arrived');

    it.todo('says which sku is unknown rather than inventing one');
  });
});
