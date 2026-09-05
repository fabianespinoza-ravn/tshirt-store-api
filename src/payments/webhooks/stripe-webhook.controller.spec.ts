import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService, WebhookOutcome } from './stripe-webhook.service';

/**
 * A request as Nest hands it to the route: the raw bytes present, the parsed
 * body irrelevant.
 *
 * `rawBody` is optional in Nest's own type because the application may have
 * been created without it, and the `undefined` case is a stub below rather
 * than an oversight — it is what a deployment that lost `rawBody: true`
 * looks like from inside the handler.
 */
export const aRequest = (rawBody?: Buffer): RawBodyRequest<Request> =>
  ({ rawBody }) as RawBodyRequest<Request>;

/**
 * The controller with its one dependency doubled, and that double returned
 * alongside it so a stub can say what the service did and what it was asked.
 */
export const buildController = () => {
  const webhooks = {
    receive: jest.fn().mockResolvedValue(WebhookOutcome.Queued),
  };

  return {
    controller: new StripeWebhookController(
      webhooks as unknown as StripeWebhookService,
    ),
    webhooks,
  };
};

/**
 * Three things about this controller are worth pinning, and none of them is
 * about the body it returns.
 *
 * **It is public, and that has to be provable from the metadata.** The route
 * carries no JWT because `docs/AUTHORIZATION-MATRIX.md` authenticates it by
 * signature; a `@Public()` dropped in a refactor would turn every Stripe
 * delivery into a 401 that Stripe retries for three days, and no assertion
 * about the happy path would notice.
 *
 * **It answers 200 and not Nest's default 201.** The contract declares 200
 * for `receiveStripeEvent`. Stripe treats both as success, so nothing breaks
 * loudly — the served document simply stops matching the deliverable.
 *
 * **It hands the raw body over untouched.** The signature is computed over
 * those bytes; a controller that passed `request.body` would be verifying a
 * re-serialisation of the payload against a signature of the original.
 */
describe('StripeWebhookController', () => {
  describe('what it passes on', () => {
    it.todo('hands the raw body to the service, not the parsed body');
    it.todo('hands the stripe-signature header through as it arrived');
    it.todo(
      'passes undefined for a request with no raw body, rather than inventing one',
    );
    it.todo('passes undefined when the signature header is absent');
  });

  describe('what it answers', () => {
    it.todo('acknowledges with 200 rather than the 201 a POST defaults to');
    it.todo('answers the same body whatever the outcome of the delivery was');
    it.todo(
      'lets the problem thrown by the service through, so the filter shapes it',
    );
  });

  describe('how it is reachable', () => {
    it.todo(`declares ${IS_PUBLIC_KEY}, because Stripe holds no bearer token`);
    it.todo('declares no policy, because there is no subject to scope');
  });
});
