/**
 * The cases this translator owes, named and left unwritten.
 *
 * Per CLAUDE.md the assertions for generated behaviour are the student's to
 * write, so this file scaffolds the gap rather than closing it. What each
 * case needs is a plain object standing in for a Stripe error — `{ type,
 * statusCode }`, the shape `stripe.translator.ts` reads — and a
 * `toMatchObject({ kind })` against `Problems`, exactly as
 * `aws-s3.translator.spec.ts` does for the AWS SDK.
 *
 * The three groups are not arbitrary. The first two encode the rule the
 * module exists for — an upstream 4xx is a **500 of ours**, an upstream 429
 * or 5xx is a 503 — and getting them backwards blames a client for our
 * misconfiguration. The third is about restraint, and is the one that would
 * silently rot: this translator is registered, so it is handed every error
 * the filter sees, and a version that claimed a bare `ECONNREFUSED` would
 * pass every other test in this file while the logs began attributing every
 * network failure in the process to Stripe.
 *
 * Until these are written, the 503 and 500 branches are covered only
 * indirectly, through `payment-links.service.spec.ts`.
 */
describe('translateStripeError', () => {
  describe('the dependency is busy or down', () => {
    it.todo('answers 503 for a StripeRateLimitError carrying an upstream 429');

    it.todo(
      'answers 503 for a StripeConnectionError, which carries no status at all',
    );

    it.todo('answers 503 for an upstream 500, 502, 503 and 504');

    it.todo('serves a detail that does not name Stripe');
  });

  describe('the upstream status is never passed through', () => {
    it.todo(
      'turns a StripeInvalidRequestError with an upstream 400 into a 500 of ours',
    );

    it.todo(
      'turns a StripeAuthenticationError with an upstream 401 into a 500 of ours, not a 401',
    );

    it.todo('answers 500 for a Stripe error carrying no upstream status');
  });

  describe('what it declines', () => {
    it.todo('declines a socket error whose code is ECONNREFUSED');

    it.todo(
      'declines an error that carries only a statusCode, which anything can',
    );

    it.todo('declines an error whose type is not prefixed Stripe');

    it.todo('declines a primitive and null');
  });
});
