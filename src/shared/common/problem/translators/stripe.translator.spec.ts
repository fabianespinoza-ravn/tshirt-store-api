import { Problems } from '../problem.catalog';
import { translateStripeError } from './stripe.translator';

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
    it('answers 503 for a StripeRateLimitError carrying an upstream 429', () => {
      expect(
        translateStripeError({ type: 'StripeRateLimitError', statusCode: 429 }),
      ).toMatchObject({ kind: Problems.serviceUnavailable });
    });

    it('answers 503 for a StripeConnectionError, which carries no status at all', () => {
      expect(
        translateStripeError({ type: 'StripeConnectionError' }),
      ).toMatchObject({
        kind: Problems.serviceUnavailable,
      });
    });

    it('answers 503 for an upstream 500, 502, 503 and 504', () => {
      for (const statusCode of [500, 502, 503, 504]) {
        expect(
          translateStripeError({ type: 'StripeAPIError', statusCode }),
        ).toMatchObject({ kind: Problems.serviceUnavailable });
      }
    });

    it('serves a detail that does not name Stripe', () => {
      const translation = translateStripeError({
        type: 'StripeRateLimitError',
        statusCode: 429,
      });

      expect(translation?.detail).not.toMatch(/stripe/i);
    });
  });

  describe('the upstream status is never passed through', () => {
    it('turns a StripeInvalidRequestError with an upstream 400 into a 500 of ours', () => {
      expect(
        translateStripeError({
          type: 'StripeInvalidRequestError',
          statusCode: 400,
        }),
      ).toMatchObject({ kind: Problems.internalError });
    });

    it('turns a StripeAuthenticationError with an upstream 401 into a 500 of ours, not a 401', () => {
      expect(
        translateStripeError({
          type: 'StripeAuthenticationError',
          statusCode: 401,
        }),
      ).toMatchObject({ kind: Problems.internalError });
    });

    it('answers 500 for a Stripe error carrying no upstream status', () => {
      expect(
        translateStripeError({ type: 'StripeInvalidRequestError' }),
      ).toMatchObject({
        kind: Problems.internalError,
      });
    });
  });

  describe('what it declines', () => {
    it('declines a socket error whose code is ECONNREFUSED', () => {
      expect(translateStripeError({ code: 'ECONNREFUSED' })).toBeUndefined();
    });

    it('declines an error that carries only a statusCode, which anything can', () => {
      expect(translateStripeError({ statusCode: 503 })).toBeUndefined();
    });

    it('declines an error whose type is not prefixed Stripe', () => {
      expect(
        translateStripeError({ type: 'DatabaseError', statusCode: 503 }),
      ).toBeUndefined();
    });

    it('declines a primitive and null', () => {
      expect(translateStripeError('StripeConnectionError')).toBeUndefined();
      expect(translateStripeError(null)).toBeUndefined();
    });
  });
});
