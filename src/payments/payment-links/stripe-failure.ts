import { Problems } from '../../common/problem/problem.catalog';
import { ProblemException } from '../../common/problem/problem.exception';
import { GENERIC_INTERNAL_DETAIL } from '../../common/problem/translators';

/**
 * A failed call to Stripe, classified into the catalog.
 *
 * The rule is the one `aws-s3.translator.ts` states and this file only
 * applies: **an upstream status code is never our status code.** The caller
 * of this API did not call Stripe. A 400 or a 404 from Stripe means *we*
 * built the request wrong — a bad amount, a currency the account cannot
 * take, a key that no longer works — and passing that through would blame
 * the manager for our misconfiguration. So an upstream 4xx becomes our 500.
 * A 429 or a 5xx means Stripe is busy or down, and that is the one thing a
 * client can act on: it becomes our 503.
 *
 * There is no 4xx of ours in here at all, and that is deliberate for this
 * route. The only Stripe failure an end user actually causes is a declined
 * card, and no card is presented when a manager creates a link — the buyer
 * meets the card later, on Stripe's own page, where a decline never reaches
 * this API.
 *
 * It lives here rather than in `common/problem/translators/` because it is
 * not a translator: it returns an exception for one call site to throw,
 * instead of registering a claim over every error the filter ever sees. The
 * registry is where this belongs once the webhook branch lands and Stripe
 * errors can arrive from more than one place; that is a merge, not a
 * decision to take twice.
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

const UNAVAILABLE_DETAIL =
  'A dependency of this API is temporarily unavailable. Try again shortly.';

/**
 * Duck-typed rather than `instanceof Stripe.errors.StripeError`, for the
 * reason the AWS translator gives about `$metadata`: the shape is what
 * identifies the error, and a socket failure the SDK re-throws does not
 * always arrive as the class. Being wrong here is safe in one direction
 * only, so anything unrecognised falls through to the generic 500.
 */
function stripeErrorShape(
  error: unknown,
): { type?: string; statusCode?: number } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const { type, statusCode } = error as {
    type?: unknown;
    statusCode?: unknown;
  };

  if (typeof type !== 'string' && typeof statusCode !== 'number') {
    return undefined;
  }

  return {
    type: typeof type === 'string' ? type : undefined,
    statusCode: typeof statusCode === 'number' ? statusCode : undefined,
  };
}

export function stripeFailure(error: unknown): ProblemException {
  const shape = stripeErrorShape(error);

  const retryable =
    shape !== undefined &&
    ((shape.type !== undefined && RETRYABLE_TYPES.has(shape.type)) ||
      (shape.statusCode !== undefined &&
        RETRYABLE_UPSTREAM_STATUS.has(shape.statusCode)));

  return retryable
    ? new ProblemException(Problems.serviceUnavailable, UNAVAILABLE_DETAIL)
    : new ProblemException(Problems.internalError, GENERIC_INTERNAL_DETAIL);
}
