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
 * Whether a failure is kept is decided by what its payload carries, not by
 * a house style. A settlement job holds a Stripe identifier: it stays in the
 * failed set forever, where it can be counted, alerted on and retried by
 * hand, and losing one is unacceptable. A mail job holds a live one-time
 * token, so it is dropped the moment it fails and its diagnosis lives in the
 * log instead. Keeping everything would have been the tidier rule and the
 * wrong one.
 */

/**
 * Mail. Three attempts, then it parks — and it keeps nothing it does not
 * have to.
 *
 * Losing a verification email is bad and recoverable — the client can ask
 * for another — so the retries ride out a transient SMTP refusal rather than
 * guaranteeing delivery.
 *
 * The retention is the part worth reading twice. A mail job's payload
 * carries the recipient and, for verification and password reset, the
 * **one-time token in plain text** — the database keeps only its hash, so
 * the job is the only place the usable value exists.
 *
 * So this queue keeps nothing at all, completed or failed. An age bound was
 * the first answer and it is not enough: BullMQ prunes by age *lazily*, when
 * the next job of that kind finishes, so on a queue that goes quiet the last
 * failures — the ones holding live tokens — sit there until something else
 * fails. On a queue nobody is failing, that is forever.
 *
 * What is given up is retrying a failed send by hand, and for mail that is
 * an acceptable trade: three attempts have already happened, and a client
 * who never got their verification link asks for another one. The diagnosis
 * lives in the consumer's log, which records the recipient and the error and
 * never the token — that is a requirement of whoever writes the mail
 * processor, not an optional nicety.
 */
export const MAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/**
 * Settlement. Retries for about a day, then parks and is alerted on.
 *
 * There is no number of attempts after which losing a payment is
 * acceptable, so this never gives up quietly. What happens after the
 * attempts run out is a human being looking at the failed set, which is why
 * the count of failures on this queue is a monitored value and not just a
 * number.
 *
 * The attempt count is arithmetic and not a round number. BullMQ's
 * exponential strategy has **no cap**: with a 10s seed the nth retry waits
 * 10s × 2^(n-1), so the delays sum to 10s × (2^retries − 1). Twenty-four
 * attempts would therefore span about 970 days, not the day it was meant
 * to. Fourteen attempts — thirteen retries — sum to 81,910 seconds, a
 * little under twenty-three hours, with the first few retries still quick
 * enough to ride out a blip.
 *
 * The job has no consumer until block 5, when the webhook produces it. The
 * policy is here because it is a decision, not an implementation.
 */
export const SETTLEMENT_JOB_OPTIONS: JobsOptions = {
  attempts: 14,
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
  // A recipient list is not a token, but it is still personal data with no
  // reason to outlive the send, and the same lazy-pruning problem applies.
  removeOnComplete: true,
  removeOnFail: true,
};
