import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Stripe from 'stripe';

/* Jest's asymmetric matchers are typed as `any`; these are partial checks of
 * Prisma and BullMQ calls and are never values passed to production code. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { buildService, type ServiceHarness } from '../../testing/build-service';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { Problems } from '../../common/problem/problem.catalog';
import type { ProblemException } from '../../common/problem/problem.exception';
import { JobName, QueueName } from '../../queue/queue.constants';
import { SettlementEventType } from './settlement.jobs';
import { StripeWebhookService, WebhookOutcome } from './stripe-webhook.service';

const orderId = '018f3b6f-0000-7000-8000-000000000001';
const paymentIntentId = 'pi_settled_by_the_suite';
const stripeEventId = 'evt_delivered_once';
/** The `webhook_events` row a colliding insert finds already written. */
const recordedRowId = '018f3b6f-0000-7000-8000-000000000010';

/**
 * A verified event, as `constructEvent` would hand it back.
 *
 * Cast rather than built in full: `Stripe.Event` is a union of every event
 * type the SDK knows and only these four fields are read, so spelling out
 * the rest would be noise that the next SDK bump breaks.
 */
export const anEvent = (
  overrides: {
    id?: string;
    type?: string;
    intentId?: string;
    metadata?: Record<string, string>;
  } = {},
): Stripe.Event =>
  ({
    id: overrides.id ?? stripeEventId,
    type: overrides.type ?? SettlementEventType.PaymentIntentSucceeded,
    data: {
      object: {
        id: overrides.intentId ?? paymentIntentId,
        metadata: overrides.metadata ?? { orderId },
      },
    },
  }) as unknown as Stripe.Event;

/** The bytes Stripe posted, which is what the signature is computed over. */
export const rawBodyOf = (event: Stripe.Event): Buffer =>
  Buffer.from(JSON.stringify(event));

/** Shaped like the real header; its value is never verified in a unit test. */
export const aSignatureHeader = 't=1757030400,v1=deadbeef';

/** Prisma's unique violation, as the client actually throws it. */
export const aDuplicateEvent = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { modelName: 'WebhookEvent', target: ['stripeEventId'] },
  });

/**
 * What this file has to prove, and what it deliberately leaves to whoever
 * writes the assertions.
 *
 * The route is the only unauthenticated write in the API and the only one
 * Stripe will call again — for three days — if it does not like the answer.
 * Three properties decide whether that is safe, and each is a stub below
 * rather than a comment, because a case named and unwritten is a visible
 * gap while a case asserted by the same hand that wrote the code is not:
 *
 * **It never trusts a parsed body.** The signature covers the bytes Stripe
 * sent. A test that fed the service a parsed object and passed would be
 * testing a route that cannot exist in production.
 *
 * **The second delivery of an event writes nothing.** Not "writes the same
 * thing twice harmlessly" — writes nothing, because the insert loses to the
 * unique index and the code recognises P2002 and only P2002. The
 * counter-case matters as much: a database that is down must not be
 * acknowledged, or Stripe stops retrying a payment nobody recorded.
 *
 * **It acknowledges without settling.** No order moves here, no stock
 * moves here, no money moves here. The assertion that says so is an
 * assertion about which Prisma calls did *not* happen.
 */
describe('StripeWebhookService', () => {
  let h: ServiceHarness<StripeWebhookService>;

  // The settlement queue, injected by token because `@InjectQueue` resolves
  // to one BullMQ registers and there is no BullMQ in a unit test. The token
  // below is the whole of "onto the right queue": the module would not
  // compile if the service asked for a different one.
  const queue = { add: jest.fn() };

  beforeEach(async () => {
    h = await buildService(StripeWebhookService, [
      { provide: getQueueToken(QueueName.Settlement), useValue: queue },
    ]);
    resetPrismaMock(h.prisma);
    queue.add.mockReset();

    // The ordinary delivery: a signature that verifies, an event nobody has
    // seen, and a queue that accepts the job. Every stub below overrides
    // exactly one of those three.
    h.stripe.constructWebhookEvent.mockReturnValue(anEvent());
    h.prisma.webhookEvent.create.mockResolvedValue(
      {} as Awaited<ReturnType<typeof h.prisma.webhookEvent.create>>,
    );
    queue.add.mockResolvedValue({ id: stripeEventId });
  });

  /** A signature failure as the SDK raises it, carrying its own reason. */
  const aSignatureFailure = (reason: string) =>
    new Stripe.errors.StripeSignatureVerificationError(
      aSignatureHeader,
      'the bytes Stripe posted',
      { message: reason },
    );

  /** The row a colliding insert finds already there. */
  const anAlreadyRecordedRow = (processedAt: Date | null) =>
    ({ id: recordedRowId, processedAt }) as never;

  describe('verifying the delivery', () => {
    it('verifies the signature over the raw bytes, not over the parsed body', async () => {
      const event = anEvent();
      const rawBody = rawBodyOf(event);

      await h.service.receive(rawBody, aSignatureHeader);

      // Reference identity, not deep equality: it says the bytes reached
      // Stripe untouched, where an equal-looking Buffer would also admit a
      // re-serialisation of a body that had been parsed on the way.
      expect(h.stripe.constructWebhookEvent.mock.calls[0]?.[0]).toBe(rawBody);
      expect(h.stripe.constructWebhookEvent).toHaveBeenCalledTimes(1);
    });

    it('passes the Stripe-Signature header through unchanged', async () => {
      await h.service.receive(rawBodyOf(anEvent()), aSignatureHeader);

      expect(h.stripe.constructWebhookEvent).toHaveBeenCalledWith(
        expect.any(Buffer),
        aSignatureHeader,
      );
    });

    it('answers 400 when the header is missing, because the caller sent no credential', async () => {
      await expect(
        h.service.receive(rawBodyOf(anEvent()), undefined),
      ).rejects.toMatchObject({
        kind: {
          type: Problems.validation.type,
          title: Problems.validation.title,
          status: 400,
        },
      });

      expect(h.stripe.constructWebhookEvent).not.toHaveBeenCalled();
    });

    it('answers 400 when the signature does not verify, and records nothing', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      h.stripe.constructWebhookEvent.mockImplementation(() => {
        throw aSignatureFailure('No signatures found matching the payload.');
      });

      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).rejects.toMatchObject({
        kind: {
          type: Problems.validation.type,
          title: Problems.validation.title,
          status: 400,
        },
      });

      expect(h.prisma.webhookEvent.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('answers 500 when the raw body is absent, because that is our bootstrap and not their request', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await expect(
        h.service.receive(undefined, aSignatureHeader),
      ).rejects.toMatchObject({
        kind: {
          type: Problems.internalError.type,
          title: Problems.internalError.title,
          status: 500,
        },
      });

      expect(h.stripe.constructWebhookEvent).not.toHaveBeenCalled();
      expect(h.prisma.webhookEvent.create).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it('never puts the reason a signature failed into the response, only into the log', async () => {
      const reason = 'Timestamp outside the tolerance zone';
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      h.stripe.constructWebhookEvent.mockImplementation(() => {
        throw aSignatureFailure(reason);
      });

      const rejection = await h.service
        .receive(rawBodyOf(anEvent()), aSignatureHeader)
        .then(
          () => null,
          (error: ProblemException) => error,
        );

      expect(rejection?.detail).toBe(
        'The Stripe signature could not be verified.',
      );
      // The served document, which is what the filter hands the client: an
      // endpoint that explained why a forgery failed would be a tool for
      // producing one that works.
      expect(JSON.stringify(rejection?.getResponse())).not.toContain(reason);
      expect(warn).toHaveBeenCalledWith(
        `Rejected a Stripe delivery: ${reason}`,
      );
      warn.mockRestore();
    });

    it('lets an error that is not a signature failure through, rather than reporting it as a bad signature', async () => {
      const boom = new Error('the webhook secret was never configured');
      h.stripe.constructWebhookEvent.mockImplementation(() => {
        throw boom;
      });

      // The same error object, so a version that wrapped everything the
      // `try` threw into `Problems.validation` fails here.
      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).rejects.toBe(boom);

      expect(h.prisma.webhookEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('recording the event', () => {
    it('inserts the stripe event id, the type and the verified payload', async () => {
      const event = anEvent({ id: 'evt_written_down' });
      h.stripe.constructWebhookEvent.mockReturnValue(event);

      await h.service.receive(rawBodyOf(event), aSignatureHeader);

      expect(h.prisma.webhookEvent.create).toHaveBeenCalledWith({
        data: {
          id: expect.any(String),
          stripeEventId: 'evt_written_down',
          eventType: SettlementEventType.PaymentIntentSucceeded,
          payload: event,
        },
      });
    });

    it('catches P2002 and answers, rather than letting the unique violation out', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      h.prisma.webhookEvent.create.mockRejectedValue(aDuplicateEvent());
      h.prisma.webhookEvent.findUnique.mockResolvedValue(
        anAlreadyRecordedRow(null),
      );

      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).resolves.toBe(WebhookOutcome.Requeued);

      warn.mockRestore();
    });

    it('writes nothing a second time when P2002 says the event is already recorded', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      h.prisma.webhookEvent.create.mockRejectedValue(aDuplicateEvent());
      h.prisma.webhookEvent.findUnique.mockResolvedValue(
        anAlreadyRecordedRow(new Date('2026-09-01T00:00:00.000Z')),
      );

      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).resolves.toBe(WebhookOutcome.Replay);

      expect(queue.add).not.toHaveBeenCalled();
      expect(h.prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('rethrows a Prisma error that is not P2002, so a database that is down is never acknowledged', async () => {
      const unreachable = new Prisma.PrismaClientKnownRequestError(
        'Server has closed the connection',
        { code: 'P1017', clientVersion: Prisma.prismaVersion.client },
      );
      h.prisma.webhookEvent.create.mockRejectedValue(unreachable);

      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).rejects.toBe(unreachable);

      // Not even looked for: a code other than P2002 says nothing about a
      // row existing, and a lookup here would be the beginning of treating
      // it as a duplicate.
      expect(h.prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('reads the recorded row when the insert collides, and carries its id into the job', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const event = anEvent();
      h.prisma.webhookEvent.create.mockRejectedValue(aDuplicateEvent());
      h.prisma.webhookEvent.findUnique.mockResolvedValue(
        anAlreadyRecordedRow(null),
      );

      await h.service.receive(rawBodyOf(event), aSignatureHeader);

      expect(h.prisma.webhookEvent.findUnique).toHaveBeenCalledWith({
        where: { stripeEventId: event.id },
        select: { id: true, processedAt: true },
      });
      // The existing row's id and not the uuid this call generated: a job
      // carrying an id no row has would settle the order and leave the event
      // looking unhandled forever.
      expect(queue.add).toHaveBeenCalledWith(
        JobName.SettlePayment,
        {
          webhookEventId: recordedRowId,
          stripeEventId: event.id,
          eventType: SettlementEventType.PaymentIntentSucceeded,
          paymentIntentId,
          orderId,
        },
        { jobId: event.id },
      );
      warn.mockRestore();
    });

    it('does not enqueue for a delivery whose recorded row is already stamped processed', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      h.prisma.webhookEvent.create.mockRejectedValue(aDuplicateEvent());
      h.prisma.webhookEvent.findUnique.mockResolvedValue(
        anAlreadyRecordedRow(new Date('2026-09-01T00:00:00.000Z')),
      );

      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).resolves.toBe(WebhookOutcome.Replay);

      expect(queue.add).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('asks for the job again when the recorded row was never settled, so a failed enqueue is not final', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      h.prisma.webhookEvent.create.mockRejectedValue(aDuplicateEvent());
      h.prisma.webhookEvent.findUnique.mockResolvedValue(
        anAlreadyRecordedRow(null),
      );

      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).resolves.toBe(WebhookOutcome.Requeued);

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        `Stripe event ${stripeEventId} was recorded but never settled; its job was asked for again.`,
      );
      warn.mockRestore();
    });

    it('rethrows when the row that won the insert cannot be read back, rather than acknowledging it', async () => {
      const duplicate = aDuplicateEvent();
      h.prisma.webhookEvent.create.mockRejectedValue(duplicate);
      h.prisma.webhookEvent.findUnique.mockResolvedValue(null);

      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).rejects.toBe(duplicate);

      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('enqueuing the settlement', () => {
    it('enqueues one settle-payment job carrying the webhook event id, the intent and the order', async () => {
      const event = anEvent();

      await h.service.receive(rawBodyOf(event), aSignatureHeader);

      // The id the insert used, read back off the call rather than guessed,
      // so the job and the row are pinned to each other.
      const inserted = h.prisma.webhookEvent.create.mock.calls[0]?.[0].data;

      expect(typeof inserted?.id).toBe('string');
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        JobName.SettlePayment,
        {
          webhookEventId: inserted?.id,
          stripeEventId: event.id,
          eventType: SettlementEventType.PaymentIntentSucceeded,
          paymentIntentId,
          orderId,
        },
        { jobId: event.id },
      );
    });

    it('uses the stripe event id as the job id, so a redelivery collapses onto the same job', async () => {
      const event = anEvent({ id: 'evt_redelivered' });
      h.stripe.constructWebhookEvent.mockReturnValue(event);

      await h.service.receive(rawBodyOf(event), aSignatureHeader);

      // The whole options object, so an added option or a `jobId` built from
      // something else is a failure and not a pass.
      expect(queue.add).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { jobId: 'evt_redelivered' },
      );
    });

    it('records but does not enqueue an event type this API does not settle', async () => {
      const event = anEvent({ type: 'checkout.session.completed' });
      h.stripe.constructWebhookEvent.mockReturnValue(event);

      await expect(
        h.service.receive(rawBodyOf(event), aSignatureHeader),
      ).resolves.toBe(WebhookOutcome.Recorded);

      expect(h.prisma.webhookEvent.create).toHaveBeenCalledWith({
        data: {
          id: expect.any(String),
          stripeEventId: event.id,
          eventType: 'checkout.session.completed',
          payload: event,
        },
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('records but does not enqueue a succeeded intent whose metadata carries no order id', async () => {
      const event = anEvent({ metadata: {} });
      h.stripe.constructWebhookEvent.mockReturnValue(event);

      await expect(
        h.service.receive(rawBodyOf(event), aSignatureHeader),
      ).resolves.toBe(WebhookOutcome.Recorded);

      expect(h.prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('lets a failure to enqueue surface, so the caller answers 500 and Stripe redelivers', async () => {
      const redisDown = new Error('Redis refused the connection');
      queue.add.mockRejectedValue(redisDown);

      // Unwrapped: an acknowledgement here would end the three days of
      // retries with the row written and no job to settle it.
      await expect(
        h.service.receive(rawBodyOf(anEvent()), aSignatureHeader),
      ).rejects.toBe(redisDown);
    });

    it('reuses the stripe event id as the job id on the second attempt too', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const event = anEvent({ id: 'evt_redelivered' });
      h.stripe.constructWebhookEvent.mockReturnValue(event);

      await h.service.receive(rawBodyOf(event), aSignatureHeader);

      // The redelivery: the insert loses to the unique index and the
      // recorded row was never settled, which is the path that asks again.
      h.prisma.webhookEvent.create.mockRejectedValueOnce(aDuplicateEvent());
      h.prisma.webhookEvent.findUnique.mockResolvedValue(
        anAlreadyRecordedRow(null),
      );

      await h.service.receive(rawBodyOf(event), aSignatureHeader);

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.anything(),
        { jobId: 'evt_redelivered' },
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.anything(),
        { jobId: 'evt_redelivered' },
      );
      warn.mockRestore();
    });

    // The repeated job id is a convenience in front of the guarantee, not
    // the guarantee itself: a replay must not invoke any order, stock or
    // payment write on this request path.
    it('applies nothing twice when the same delivery is settled again, which a repeated job id does not prove', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const event = anEvent({ id: 'evt_applied_once' });
      h.stripe.constructWebhookEvent.mockReturnValue(event);

      await h.service.receive(rawBodyOf(event), aSignatureHeader);

      h.prisma.webhookEvent.create.mockRejectedValueOnce(aDuplicateEvent());
      h.prisma.webhookEvent.findUnique.mockResolvedValue(
        anAlreadyRecordedRow(new Date('2026-09-01T00:00:00.000Z')),
      );

      await expect(
        h.service.receive(rawBodyOf(event), aSignatureHeader),
      ).resolves.toBe(WebhookOutcome.Replay);

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.sku.update).not.toHaveBeenCalled();
      expect(h.prisma.payment.updateMany).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('what it must not do', () => {
    it('moves no order', async () => {
      await h.service.receive(rawBodyOf(anEvent()), aSignatureHeader);

      expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.order.update).not.toHaveBeenCalled();
    });
    it('touches no sku, so nothing is decremented on the request path', async () => {
      await h.service.receive(rawBodyOf(anEvent()), aSignatureHeader);

      expect(h.prisma.sku.update).not.toHaveBeenCalled();
      expect(h.prisma.sku.updateMany).not.toHaveBeenCalled();
    });
    it('writes no payment row', async () => {
      await h.service.receive(rawBodyOf(anEvent()), aSignatureHeader);

      expect(h.prisma.payment.create).not.toHaveBeenCalled();
      expect(h.prisma.payment.updateMany).not.toHaveBeenCalled();
    });
    it('calls Stripe for nothing except verifying the signature', async () => {
      await h.service.receive(rawBodyOf(anEvent()), aSignatureHeader);

      expect(h.stripe.constructWebhookEvent).toHaveBeenCalledTimes(1);
      expect(h.stripe.createPaymentIntent).not.toHaveBeenCalled();
      expect(h.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(h.stripe.refundPaymentIntent).not.toHaveBeenCalled();
    });
  });
});
