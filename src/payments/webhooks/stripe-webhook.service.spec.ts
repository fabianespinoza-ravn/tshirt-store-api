import { getQueueToken } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { buildService, type ServiceHarness } from '../../testing/build-service';
import { resetPrismaMock } from '../../testing/prisma.mock';
import { QueueName } from '../../queue/queue.constants';
import { SettlementEventType } from './settlement.jobs';
import { StripeWebhookService } from './stripe-webhook.service';

const orderId = '018f3b6f-0000-7000-8000-000000000001';
const paymentIntentId = 'pi_settled_by_the_suite';
const stripeEventId = 'evt_delivered_once';

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
  // to one BullMQ registers and there is no BullMQ in a unit test.
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

  describe('verifying the delivery', () => {
    it.todo(
      'verifies the signature over the raw bytes, not over the parsed body',
    );
    it.todo('passes the Stripe-Signature header through unchanged');
    it.todo(
      'answers 400 when the header is missing, because the caller sent no credential',
    );
    it.todo(
      'answers 400 when the signature does not verify, and records nothing',
    );
    it.todo(
      'answers 500 when the raw body is absent, because that is our bootstrap and not their request',
    );
    it.todo(
      'never puts the reason a signature failed into the response, only into the log',
    );
    it.todo(
      'lets an error that is not a signature failure through, rather than reporting it as a bad signature',
    );
  });

  describe('recording the event', () => {
    it.todo('inserts the stripe event id, the type and the verified payload');
    it.todo(
      'answers without inserting anything a second time when P2002 says the event is already recorded',
    );
    it.todo(
      'rethrows a Prisma error that is not P2002, so a database that is down is never acknowledged',
    );
    it.todo(
      'does not enqueue a settlement job for a delivery it has already recorded',
    );
  });

  describe('enqueuing the settlement', () => {
    it.todo(
      'enqueues one settle-payment job carrying the webhook event id, the intent and the order',
    );
    it.todo(
      'uses the stripe event id as the job id, so a redelivery collapses onto the same job',
    );
    it.todo(
      'records but does not enqueue an event type this API does not settle',
    );
    it.todo(
      'records but does not enqueue a succeeded intent whose metadata carries no order id',
    );
    it.todo(
      'lets a failure to enqueue surface, so the caller answers 500 and Stripe redelivers',
    );
  });

  describe('what it must not do', () => {
    it.todo('moves no order');
    it.todo('touches no sku, so nothing is decremented on the request path');
    it.todo('writes no payment row');
    it.todo('calls Stripe for nothing except verifying the signature');
  });
});
