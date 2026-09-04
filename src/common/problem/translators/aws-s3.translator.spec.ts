import { translateAwsError } from './aws-s3.translator';

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
    it.todo('answers 503 for a throttle the SDK names SlowDown');
    it.todo('answers 503 for an upstream 429');
    it.todo('answers 503 for an upstream 503');
    it.todo('answers 503 for an upstream 500, 502 and 504');
    it.todo('serves a detail that does not name the failing subsystem');
  });

  describe('the upstream status is never passed through', () => {
    it.todo('turns an upstream 403 into a 500 of ours, not a 403');
    it.todo('turns an upstream 404 into a 500 of ours, not a 404');
    it.todo('answers 500 for an SDK error carrying no upstream status');
  });

  describe('what it declines', () => {
    it.todo('declines a socket error that carries no $metadata');
    it.todo('declines an error that did not come from the AWS SDK');
  });

  void translateAwsError;
  void anAwsError;
  void aSocketError;
});
