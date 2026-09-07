import { HttpStatus, type RawBodyRequest } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { CHECK_POLICIES_KEY } from '../../auth/casl/check-policies.decorator';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { Problems } from '../../common/problem/problem.catalog';
import { ProblemException } from '../../common/problem/problem.exception';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService, WebhookOutcome } from './stripe-webhook.service';

/** Shaped like the real header; the controller never looks inside it. */
const aSignatureHeader = 't=1757030400,v1=deadbeef';

/** The handler itself, which is where every route decorator hangs its metadata. */
const theHandler: object = StripeWebhookController.prototype.receiveStripeEvent;

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
    it('hands the raw body to the service, not the parsed body', async () => {
      const { controller, webhooks } = buildController();
      const rawBody = Buffer.from('{"id":"evt_as_stripe_sent_it"}');
      const request = aRequest(rawBody);
      // A parsed body that does not re-serialise to the same bytes, so a
      // controller reaching for `request.body` fails here rather than
      // passing on a payload the signature was never computed over.
      (request as unknown as { body: unknown }).body = { id: 'evt_reparsed' };

      await controller.receiveStripeEvent(request, aSignatureHeader);

      expect(webhooks.receive).toHaveBeenCalledWith(rawBody, aSignatureHeader);
    });

    it('hands the stripe-signature header through as it arrived', async () => {
      const { controller, webhooks } = buildController();

      await controller.receiveStripeEvent(
        aRequest(Buffer.from('{}')),
        aSignatureHeader,
      );

      expect(webhooks.receive).toHaveBeenCalledWith(
        expect.any(Buffer),
        aSignatureHeader,
      );
    });

    it('passes undefined for a request with no raw body, rather than inventing one', async () => {
      const { controller, webhooks } = buildController();

      await controller.receiveStripeEvent(aRequest(), aSignatureHeader);

      expect(webhooks.receive).toHaveBeenCalledWith(
        undefined,
        aSignatureHeader,
      );
    });

    it('passes undefined when the signature header is absent', async () => {
      const { controller, webhooks } = buildController();

      await controller.receiveStripeEvent(aRequest(Buffer.from('{}')));

      expect(webhooks.receive).toHaveBeenCalledWith(
        expect.any(Buffer),
        undefined,
      );
    });
  });

  describe('what it answers', () => {
    it('acknowledges with 200 rather than the 201 a POST defaults to', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, theHandler)).toBe(
        HttpStatus.OK,
      );
    });

    it('answers the same body whatever the outcome of the delivery was', async () => {
      const { controller, webhooks } = buildController();

      for (const outcome of Object.values(WebhookOutcome)) {
        webhooks.receive.mockResolvedValueOnce(outcome);

        // `toEqual` and not `objectContaining`: Stripe reads the status and
        // nothing else, so a body that grew a field is a contract change.
        await expect(
          controller.receiveStripeEvent(
            aRequest(Buffer.from('{}')),
            aSignatureHeader,
          ),
        ).resolves.toEqual({ received: true });
      }

      expect(webhooks.receive).toHaveBeenCalledTimes(
        Object.values(WebhookOutcome).length,
      );
    });

    it('lets the problem thrown by the service through, so the filter shapes it', async () => {
      const { controller, webhooks } = buildController();
      const problem = new ProblemException(
        Problems.validation,
        'The Stripe signature could not be verified.',
      );
      webhooks.receive.mockRejectedValueOnce(problem);

      const rejection = await controller
        .receiveStripeEvent(aRequest(Buffer.from('{}')), aSignatureHeader)
        .then(
          () => null,
          (error: ProblemException) => error,
        );

      // The same exception, and named by its problem kind rather than by its
      // class: `toBeInstanceOf(ProblemException)` would hold for every one
      // of the twenty in the catalog.
      expect(rejection).toBe(problem);
      expect(rejection?.kind).toEqual({
        type: Problems.validation.type,
        title: Problems.validation.title,
        status: Problems.validation.status,
      });
    });
  });

  describe('how it is reachable', () => {
    it(`declares ${IS_PUBLIC_KEY}, because Stripe holds no bearer token`, () => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, theHandler)).toBe(true);
    });

    it('declares no policy, because there is no subject to scope', () => {
      expect(
        Reflect.getMetadata(CHECK_POLICIES_KEY, theHandler),
      ).toBeUndefined();
    });
  });
});
