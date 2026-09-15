import Stripe from 'stripe';
import { Problems } from '../problem.catalog';
import {
  GENERIC_INTERNAL_DETAIL,
  type ProblemTranslation,
  type ProblemTranslator,
} from './problem-translator';

/**
 * The rule this file applies is the one `aws-s3.translator.ts` states once:
 * **an upstream status code is never our status code.**
 *
 * The client of this API did not call Stripe. A 400, a 401 or a 404 from
 * Stripe means *we* built the request wrong — a bad amount, a currency the
 * account cannot take, a key that no longer works — and passing that through
 * would blame the caller for our own misconfiguration. So an upstream 4xx
 * becomes a 500 of ours. A 429 or a 5xx means Stripe is busy or down, and
 * that *is* actionable: it becomes a 503, the one answer that tells a client
 * the request itself was fine.
 *
 * There is no 4xx of ours in here, and the omission is deliberate. The only
 * Stripe failure an end user actually causes is a declined card, which would
 * earn a 402 — and no card is presented on any route that reaches this
 * translator today. A manager creating a link presents none, and the buyer
 * meets the card later on Stripe's own page, where a decline never reaches
 * this API. `Problems` carries no 402 entry for the same reason; the webhook
 * branch is where both would be added together, or not at all.
 */
const RETRYABLE_UPSTREAM_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Error `type`s that mean the dependency is unwell rather than misused. A
 * connection error carries no status code at all — there was no response —
 * so the status test below cannot see it.
 */
const RETRYABLE_TYPES = new Set([
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
]);

/** The detail every retryable failure serves, whatever produced it. */
const UNAVAILABLE_DETAIL =
  'A dependency of this API is temporarily unavailable. Try again shortly.';

/**
 * Whether this error came from the Stripe SDK at all.
 *
 * Registering here means being handed every error the filter ever sees, so
 * the restraint `aws-s3.translator.ts` describes matters more than it did
 * when this logic lived at one call site. A bare socket error —
 * `ECONNREFUSED` with no `type` — could have come from Stripe, from Postgres,
 * from the mail transport or from anywhere else, and nothing here can tell.
 * A `statusCode` on its own is no better: plenty of errors in a Node process
 * carry one. Both are declined, and stay the 500 they are today. A wrong
 * attribution in a log costs more than a generic answer.
 *
 * The duck-typed half exists next to the `instanceof` for the reason the AWS
 * translator gives about `$metadata`: an error that crossed a module
 * boundary, or one the SDK re-threw, does not always arrive as the class.
 * Stripe's own `type` values are the discriminator it publishes, and every
 * one of them is prefixed.
 */
function stripeErrorShape(
  error: unknown,
): { type?: string; statusCode?: number } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const { type, statusCode } = error as {
    type?: unknown;
    statusCode?: unknown;
  };

  const named = typeof type === 'string' && type.startsWith('Stripe');

  if (!named && !(error instanceof Stripe.errors.StripeError)) {
    return undefined;
  }

  return {
    type: typeof type === 'string' ? type : undefined,
    statusCode: typeof statusCode === 'number' ? statusCode : undefined,
  };
}

export const translateStripeError: ProblemTranslator = (
  error: unknown,
): ProblemTranslation | undefined => {
  const shape = stripeErrorShape(error);

  if (shape === undefined) return undefined;

  const retryable =
    (shape.type !== undefined && RETRYABLE_TYPES.has(shape.type)) ||
    (shape.statusCode !== undefined &&
      RETRYABLE_UPSTREAM_STATUS.has(shape.statusCode));

  if (retryable) {
    return { kind: Problems.serviceUnavailable, detail: UNAVAILABLE_DETAIL };
  }

  // Everything else Stripe can throw is ours to fix: a malformed request, a
  // rotated key, an account that cannot take the currency. It is already a
  // 500 without this branch; claiming it here is what puts the Stripe error
  // type into the log line, which is the whole reason the case is worth
  // recognising.
  return { kind: Problems.internalError, detail: GENERIC_INTERNAL_DETAIL };
};
