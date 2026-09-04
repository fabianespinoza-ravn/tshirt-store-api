import { translateAwsError } from './aws-s3.translator';
import { Problems } from '../problem.catalog';

/**
 * Harness only: each case names one branch, and the assertions are the
 * student's (CLAUDE.md, Tests).
 *
 * The cases that matter are the two that encode the rule the module exists
 * for: an upstream 403 or 404 becomes a **500 of ours**, never a 4xx, because
 * the caller did not talk to S3 and did nothing wrong — we sent a key or a
 * credential we should not have. Getting that backwards blames a client for
 * our misconfiguration and leaks the shape of our infrastructure while doing
 * it. The mirror case, an upstream 429 or 5xx becoming a 503, is what makes
 * the whole exercise worth anything.
 *
 * The last one is about restraint: a bare socket error with no `$metadata`
 * could have come from S3, from the mail transport or from anywhere, so the
 * translator declines it. Assert that it declines — a test that let it claim
 * everything would pass while the logs started attributing every network
 * failure in the process to S3.
 */
describe('translateAwsError', () => {
  /** What the SDK throws: the upstream code in `name`, the status in `$metadata`. */
  const anAwsError = (name: string, httpStatusCode?: number): Error => {
    const error = new Error('from the harness');
    error.name = name;
    Object.assign(error, { $metadata: { httpStatusCode } });
    return error;
  };

  /** A socket-level failure with nothing that identifies its origin. */
  const aSocketError = (code: string): Error =>
    Object.assign(new Error('from the harness'), { code });

  describe('the dependency is busy or down', () => {
    it('answers 503 for a throttle the SDK names SlowDown', () => {
      expect(translateAwsError(anAwsError('SlowDown'))).toMatchObject({
        kind: Problems.serviceUnavailable,
      });
    });

    it('answers 503 for an upstream 429', () => {
      expect(translateAwsError(anAwsError('AccessDenied', 429))).toMatchObject({
        kind: Problems.serviceUnavailable,
      });
    });

    it('answers 503 for an upstream 503', () => {
      expect(translateAwsError(anAwsError('AccessDenied', 503))).toMatchObject({
        kind: Problems.serviceUnavailable,
      });
    });

    it('answers 503 for an upstream 500, 502 and 504', () => {
      for (const status of [500, 502, 504]) {
        expect(
          translateAwsError(anAwsError('AccessDenied', status)),
        ).toMatchObject({ kind: Problems.serviceUnavailable });
      }
    });

    it('serves a detail that does not name the failing subsystem', () => {
      expect(translateAwsError(anAwsError('SlowDown'))?.detail).not.toMatch(
        /aws|s3/i,
      );
    });
  });

  describe('the upstream status is never passed through', () => {
    it('turns an upstream 403 into a 500 of ours, not a 403', () => {
      expect(translateAwsError(anAwsError('AccessDenied', 403))).toMatchObject({
        kind: Problems.internalError,
      });
    });

    it('turns an upstream 404 into a 500 of ours, not a 404', () => {
      expect(translateAwsError(anAwsError('NoSuchKey', 404))).toMatchObject({
        kind: Problems.internalError,
      });
    });

    it('answers 500 for an SDK error carrying no upstream status', () => {
      expect(translateAwsError(anAwsError('AccessDenied'))).toMatchObject({
        kind: Problems.internalError,
      });
    });
  });

  describe('what it declines', () => {
    it('declines a socket error that carries no $metadata', () => {
      expect(translateAwsError(aSocketError('ECONNREFUSED'))).toBeUndefined();
    });

    it('declines an error that did not come from the AWS SDK', () => {
      expect(translateAwsError(new Error('from the harness'))).toBeUndefined();
    });
  });
});
