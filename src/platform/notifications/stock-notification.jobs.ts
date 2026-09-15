/**
 * What travels on `QueueName.StockNotification`.
 *
 * Two identifiers and nothing else. The recipient list is **not** in here,
 * and that is the decision worth reading twice: a product with a few
 * thousand likes would put a few thousand addresses into a Redis payload
 * that `STOCK_NOTIFICATION_JOB_OPTIONS` then has to promise to discard, and
 * every retry would re-deliver a list computed before the crossing rather
 * than one computed now. Resolving the recipients inside the job keeps the
 * personal data in Postgres, where it already is.
 *
 * `restockCycle` rides along instead of being read in the consumer because
 * it is part of *which* crossing this job is: a SKU restocked between the
 * producer's write and the consumer's run has moved on, and the job for the
 * previous cycle should notice that rather than notify against the new one.
 */
export interface StockNotificationJobData {
  skuId: string;
  restockCycle: number;
}

/**
 * What the consumer reports. Counts only — no address, no product name —
 * because BullMQ stores a job's return value next to the job, and a queue
 * that keeps nothing should not be handed anything worth keeping.
 */
export interface StockNotificationOutcome {
  /** Likers who have not bought it, before deduplication. */
  candidates: number;
  /** Mail jobs enqueued by this run. */
  notified: number;
  /** Already notified for this crossing, by an earlier run or a rival one. */
  skipped: number;
  /** Claimed, then left FAILED because the mail could not be enqueued. */
  failed: number;
  /** Whether the product image made it into the message. */
  withImage: boolean;
}
