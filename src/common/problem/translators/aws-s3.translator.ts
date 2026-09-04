import { S3ServiceException } from '@aws-sdk/client-s3';
import { Problems } from '../problem.catalog';
import {
  GENERIC_INTERNAL_DETAIL,
  type ProblemTranslation,
  type ProblemTranslator,
} from './problem-translator';

/**
 * The rule the rest of this file applies, and the one worth stating once:
 * **an upstream status code is never our status code.**
 *
 * The client of this API did not call S3. When S3 answers 403 or 404 it is
 * telling *us* that we sent a key we should not have sent, or presented a
 * credential that no longer works. Passing that 4xx through would blame the
 * caller for our own misconfiguration, and would also hand them a fact about
 * our infrastructure they have no way to act on. So an upstream 4xx becomes
 * a 500 of ours.
 *
 * The mirror case is the one worth keeping: an upstream 429 or 5xx means the
 * dependency is busy or down, and that *is* actionable — it becomes a 503,
 * which is the only answer that tells a client the request itself was fine.
 *
 * The only thing that would ever justify a 4xx of ours is a failure the end
 * user actually caused. Nothing in this module's use of S3 qualifies: the
 * bucket, the region, the credential and the key are all ours. `buildKey`
 * composes the key from a product id and a generated uuid, so a missing
 * object does not mean the caller asked for the wrong thing — it means the
 * database and the bucket have diverged, which is a 500 and a bug report,
 * not a 404.
 */
const RETRYABLE_UPSTREAM_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Error names that mean the dependency is busy or unwell. The AWS SDK
 * carries the upstream code in `name`, not in the class: an expired
 * credential and a throttle both arrive as an `S3ServiceException`, and only
 * the name separates them.
 */
const RETRYABLE_NAMES = new Set([
  'SlowDown',
  'RequestLimitExceeded',
  'ThrottlingException',
  'ServiceUnavailable',
  'InternalError',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
]);

/** The detail every retryable failure serves, whatever produced it. */
const UNAVAILABLE_DETAIL =
  'A dependency of this API is temporarily unavailable. Try again shortly.';

/**
 * Whether this error came from the AWS SDK at all.
 *
 * Being conservative here is the point. A bare socket error — `ECONNREFUSED`
 * with no `$metadata` — could have come from S3, from the mail transport, or
 * from anywhere else, and this translator has no way to tell. It declines
 * those, and they stay the 500 they are today: a wrong attribution in a log
 * costs more than a generic answer.
 */
function isAwsError(
  error: unknown,
): error is Error & { $metadata?: { httpStatusCode?: number } } {
  if (error instanceof S3ServiceException) return true;

  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { $metadata?: unknown }).$metadata === 'object' &&
    (error as { $metadata?: unknown }).$metadata !== null
  );
}

export const translateAwsError: ProblemTranslator = (
  error: unknown,
): ProblemTranslation | undefined => {
  if (!isAwsError(error)) return undefined;

  if (RETRYABLE_NAMES.has(error.name)) {
    return { kind: Problems.serviceUnavailable, detail: UNAVAILABLE_DETAIL };
  }

  const upstream = error.$metadata?.httpStatusCode;

  if (typeof upstream === 'number' && RETRYABLE_UPSTREAM_STATUS.has(upstream)) {
    return { kind: Problems.serviceUnavailable, detail: UNAVAILABLE_DETAIL };
  }

  // Everything else the SDK can throw is ours to fix: a missing bucket, a
  // rotated credential, a key that no longer matches a row. It is already a
  // 500 without this branch; claiming it here is what puts the upstream
  // error name into the log line, which is the whole reason the case is
  // worth recognising.
  return { kind: Problems.internalError, detail: GENERIC_INTERNAL_DETAIL };
};

/**
 * Extension point for week 5.
 *
 * Stripe is not a dependency yet, so there is nothing here to translate and
 * a translator written now would be untestable guesswork. When it arrives it
 * belongs beside this file and follows the same rule: Stripe's 4xx is our
 * 500, because we are the ones who built the request, and Stripe's 429 or
 * 5xx is our 503. The cases it will need are a signature that does not
 * verify on the webhook route, which is a 400 of ours because the caller
 * genuinely sent it; a delivery we have already settled, which is a 200 and
 * not an error at all; a rate limit; and an outage. A card declined is the
 * one failure in the whole integration that the end user actually caused,
 * and the only one that earns a 4xx of ours — a 402.
 */
