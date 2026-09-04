import type { JobsOptions } from 'bullmq';

/**
 * One queue per concern rather than one queue with four job names, so a
 * settlement that keeps failing cannot hold up a verification email behind
 * it, and each gets its own worker concurrency.
 */
export enum QueueName {
  Mail = 'mail',
  Maintenance = 'maintenance',
  Settlement = 'settlement',
  StockNotification = 'stock-notification',
}

export enum JobName {
  SendMail = 'send-mail',
  SweepExpiredOrders = 'sweep-expired-orders',
  SettlePayment = 'settle-payment',
  NotifyRestock = 'notify-restock',
}

/**
 * Four jobs, four policies. Treating them alike is the mistake the week 4
 * brief calls out, and the differences below are not stylistic: each answers
 * the review's question — *what happens to a job that fails twice?* — with a
 * different sentence.
 *
 * `removeOnFail: false` is common to all of them and is what makes the
 * answer sayable at all: a failed job stays in the failed set, where it can
 * be counted, alerted on and retried by hand. A job that deletes itself on
 * failure has no answer to that question.
 */

/**
 * Mail. Three attempts, then it parks.
 *
 * Losing a verification email is bad and recoverable — the client can ask
 * for another — so the retries exist to ride out a transient SMTP refusal,
 * not to guarantee delivery. Completed jobs are trimmed because they carry
 * an address and there is no reason to keep it.
 */
export const MAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 100,
  removeOnFail: false,
};

/**
 * Settlement. Retries for about a day, then parks and is alerted on.
 *
 * There is no number of attempts after which losing a payment is
 * acceptable, so this never gives up quietly: twenty-four attempts with the
 * backoff capped at an hour spans a working day, and what happens after
 * that is a human being looking at the failed set — which is why the count
 * of failures on this queue is a monitored value and not just a number.
 *
 * The job itself has no consumer until block 5, when the webhook produces
 * it. The policy is here because it is a decision, not an implementation.
 */
export const SETTLEMENT_JOB_OPTIONS: JobsOptions = {
  attempts: 24,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: 1_000,
  removeOnFail: false,
};

/**
 * The sweep. **One attempt, and that is deliberate.**
 *
 * Retrying it would be work for nothing: it runs again in sixty seconds and
 * does exactly the same thing, so a failed run costs one minute of delay,
 * not a lost job. Retrying would also put two sweeps in flight over the same
 * expired orders, which is the one thing this job must not do.
 *
 * Completed runs are trimmed hard because there are 1,440 of them a day and
 * none is interesting; failures are kept, because a sweep that fails every
 * minute is the signal.
 */
export const SWEEP_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: 20,
  removeOnFail: 100,
};

/** How often the sweep runs. */
export const SWEEP_EVERY_MS = 60_000;

/**
 * Stock notification. Mail's policy plus an image, and its consumer arrives
 * in block 7. It is a separate queue from mail because a fan-out to every
 * user who liked a product is a burst, and a burst must not delay the
 * verification email of somebody signing up while it drains.
 */
export const STOCK_NOTIFICATION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: false,
};
