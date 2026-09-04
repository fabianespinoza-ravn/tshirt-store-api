import {
  MAIL_JOB_OPTIONS,
  SETTLEMENT_JOB_OPTIONS,
  STOCK_NOTIFICATION_JOB_OPTIONS,
  SWEEP_EVERY_MS,
  SWEEP_JOB_OPTIONS,
} from './queue.constants';

/**
 * A policy test, which is an odd thing to write about constants until you
 * notice that these four have been wrong three times in one pull request:
 * the settlement window was out by three orders of magnitude, the mail
 * retention kept live tokens in Redis, and the age bound that replaced it
 * pruned lazily and so kept them anyway.
 *
 * Every one of those was a value, not a behaviour, and nothing in the suite
 * would have gone red for any of them. That is what these assertions are
 * for — not to restate the object, but to make the two decisions that carry
 * a consequence fail loudly if somebody tidies them.
 *
 * The two are: **mail keeps nothing**, because its payload holds a live
 * one-time token that the database deliberately does not, and **the sweep
 * does not retry**, because it runs again in a minute and a second attempt
 * would put two sweeps over the same expired orders.
 */
describe('the queue policies', () => {
  it('keeps no completed and no failed mail job, because both hold a token', () => {
    expect(MAIL_JOB_OPTIONS.removeOnComplete).toBe(true);
    expect(MAIL_JOB_OPTIONS.removeOnFail).toBe(true);
  });

  it('keeps a failed settlement job forever, because its payload is an identifier', () => {
    expect(SETTLEMENT_JOB_OPTIONS.removeOnFail).toBe(false);
  });

  it('keeps nothing from a stock notification either, for the recipient list', () => {
    expect(STOCK_NOTIFICATION_JOB_OPTIONS.removeOnComplete).toBe(true);
    expect(STOCK_NOTIFICATION_JOB_OPTIONS.removeOnFail).toBe(true);
  });

  it('gives the sweep exactly one attempt', () => {
    expect(SWEEP_JOB_OPTIONS.attempts).toBe(1);
  });

  it('keeps the settlement window under a day, given an uncapped exponential backoff', () => {
    const backoff = SETTLEMENT_JOB_OPTIONS.backoff;
    const delay =
      typeof backoff === 'object' && backoff !== null && 'delay' in backoff
        ? (backoff.delay ?? 0)
        : 0;
    const attempts = SETTLEMENT_JOB_OPTIONS.attempts ?? 0;
    const windowMs = delay * (2 ** (attempts - 1) - 1);

    expect(windowMs).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('runs the sweep once a minute', () => {
    expect(SWEEP_EVERY_MS).toBe(60_000);
  });
});
