import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  UserState,
} from '@prisma/client';
import type Stripe from 'stripe';
import { newId } from '../src/common/ids';
import type { PaymentLinkView } from '../src/payments/payment-links/payment-links.views';
import { createE2eApp, type E2eApp } from './support/app';
import {
  promoteToManager,
  signIn,
  signUpVerified,
  type Session,
} from './support/fixtures';
import { seedSku, type SeededSku } from './support/order-fixtures';

const PAYMENT_LINKS_ROUTE = '/api/v1/payment-links';
const WEBHOOK_ROUTE = '/api/v1/webhooks/stripe';
const GUEST_EMAIL = 'payment-link-buyer@example.test';
const UNIT_PRICE = 12_500;

function bearer(session: Session): string {
  return `Bearer ${session.accessToken}`;
}

async function managerSession(e2e: E2eApp): Promise<Session> {
  const credentials = await signUpVerified(e2e);
  await promoteToManager(e2e, credentials.email);
  return signIn(e2e, credentials);
}

async function seededLinkSku(e2e: E2eApp): Promise<SeededSku> {
  return seedSku(e2e, {
    productName: 'E2E Payment Link Tee',
    price: UNIT_PRICE,
    stock: 1,
  });
}

async function createLink(
  e2e: E2eApp,
  manager: Session,
  sku: SeededSku,
): Promise<{ status: number; body: PaymentLinkView }> {
  const response = await e2e
    .request()
    .post(PAYMENT_LINKS_ROUTE)
    .set('Authorization', bearer(manager))
    .send({ skuId: sku.id });

  return { status: response.status, body: response.body as PaymentLinkView };
}

function paidCheckoutEvent(
  stripePaymentLinkId: string,
  ids: { eventId: string; sessionId: string },
): Stripe.Event {
  return {
    id: ids.eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: ids.sessionId,
        payment_status: 'paid',
        payment_link: stripePaymentLinkId,
        payment_intent: 'pi_payment_link_e2e',
        amount_total: UNIT_PRICE,
        currency: 'usd',
        customer_details: {
          email: GUEST_EMAIL,
          name: 'Payment Link Buyer',
          address: {
            city: 'Lima',
            country: 'PE',
            line1: '123 Test Avenue',
            line2: null,
            postal_code: '15001',
            state: 'Lima',
          },
        },
      },
    },
  } as unknown as Stripe.Event;
}

async function postWebhook(e2e: E2eApp, event: Stripe.Event) {
  e2e.stripe.setWebhookEvent(event);
  return e2e
    .request()
    .post(WEBHOOK_ROUTE)
    .set('Stripe-Signature', 't=1,v1=e2e')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(event));
}

async function waitForPayment(e2e: E2eApp, checkoutSessionId: string) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const payment = await e2e.prisma.payment.findUnique({
      where: { stripeCheckoutSessionId: checkoutSessionId },
      include: { order: { include: { user: true } } },
    });
    if (payment) return payment;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('The payment-link settlement did not create its payment.');
}

async function waitForProcessedEvent(
  e2e: E2eApp,
  stripeEventId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const row = await e2e.prisma.webhookEvent.findUnique({
      where: { stripeEventId },
      select: { processedAt: true },
    });
    if (row?.processedAt) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('The payment-link webhook was not marked processed.');
}

describe('Payment links (e2e)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  beforeEach(async () => {
    await e2e.reset();
  });

  it('lets a manager publish one active link at the SKU price', async () => {
    const manager = await managerSession(e2e);
    const sku = await seededLinkSku(e2e);

    const response = await createLink(e2e, manager, sku);

    expect(response.status).toBe(201);
    expect(response.body.skuId).toBe(sku.id);
    expect(response.body.unitPrice).toBe(UNIT_PRICE);
    expect(e2e.stripe.paymentLinks).toHaveLength(1);
    expect(e2e.stripe.paymentLinks[0]).toMatchObject({
      skuId: sku.id,
      productName: sku.productName,
      unitAmount: UNIT_PRICE,
    });
    await expect(
      e2e.prisma.paymentLink.findUnique({
        where: { stripePaymentLinkId: response.body.stripePaymentLinkId },
      }),
    ).resolves.toMatchObject({
      skuId: sku.id,
      unitPriceAtCreation: UNIT_PRICE,
      isActive: true,
    });
  });

  it('denies a client before Stripe or the payment-link table is touched', async () => {
    const credentials = await signUpVerified(e2e);
    const client = await signIn(e2e, credentials);
    const sku = await seededLinkSku(e2e);

    const response = await e2e
      .request()
      .post(PAYMENT_LINKS_ROUTE)
      .set('Authorization', bearer(client))
      .send({ skuId: sku.id });

    expect(response.status).toBe(403);
    expect(e2e.stripe.paymentLinks).toEqual([]);
    await expect(e2e.prisma.paymentLink.count()).resolves.toBe(0);
  });

  it('settles a paid checkout session through the queue into a guest PAID order', async () => {
    const manager = await managerSession(e2e);
    const sku = await seededLinkSku(e2e);
    const created = await createLink(e2e, manager, sku);
    expect(created.status).toBe(201);
    const ids = {
      eventId: `evt_${newId()}`,
      sessionId: `cs_${newId()}`,
    };
    const event = paidCheckoutEvent(created.body.stripePaymentLinkId, ids);

    const response = await postWebhook(e2e, event);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    const payment = await waitForPayment(e2e, ids.sessionId);
    expect(payment.method).toBe(PaymentMethod.PAYMENT_LINK);
    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(payment.amount).toBe(UNIT_PRICE);
    expect(payment.order.status).toBe(OrderStatus.PAID);
    expect(payment.order.user.email).toBe(GUEST_EMAIL);
    expect(payment.order.user.state).toBe(UserState.GUEST);
    await expect(
      e2e.prisma.sku.findUnique({ where: { id: sku.id } }),
    ).resolves.toMatchObject({ stock: 0, reserved: 0 });
    await waitForProcessedEvent(e2e, ids.eventId);
  });

  it('treats a processed webhook redelivery as idempotent', async () => {
    const manager = await managerSession(e2e);
    const sku = await seededLinkSku(e2e);
    const created = await createLink(e2e, manager, sku);
    expect(created.status).toBe(201);
    const ids = {
      eventId: `evt_${newId()}`,
      sessionId: `cs_${newId()}`,
    };
    const event = paidCheckoutEvent(created.body.stripePaymentLinkId, ids);

    const first = await postWebhook(e2e, event);
    expect(first.status).toBe(200);
    await waitForPayment(e2e, ids.sessionId);
    await waitForProcessedEvent(e2e, ids.eventId);
    const second = await postWebhook(e2e, event);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true });
    await expect(
      e2e.prisma.payment.count({
        where: { stripeCheckoutSessionId: ids.sessionId },
      }),
    ).resolves.toBe(1);
    await expect(
      e2e.prisma.order.count({
        where: {
          payments: {
            some: { stripeCheckoutSessionId: ids.sessionId },
          },
        },
      }),
    ).resolves.toBe(1);
    await expect(
      e2e.prisma.user.count({
        where: { email: GUEST_EMAIL, state: UserState.GUEST },
      }),
    ).resolves.toBe(1);
  });
});
