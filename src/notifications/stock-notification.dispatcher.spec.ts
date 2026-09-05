import { getQueueToken } from '@nestjs/bullmq';
import { NotificationStatus, Prisma } from '@prisma/client';
import { newId } from '../common/ids';
import { QueueName } from '../queue/queue.constants';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aProduct, aSku, anImage, aUser } from '../testing/factories';
import { StockNotificationDispatcher } from './stock-notification.dispatcher';
import { LOW_STOCK_THRESHOLD } from './stock-threshold';

/** Stands in for `QueueName.Mail`, which the dispatcher produces onto. */
export const mailQueue = { add: jest.fn() };

export const buildDispatcherHarness = (): Promise<
  ServiceHarness<StockNotificationDispatcher>
> =>
  buildService(StockNotificationDispatcher, [
    { provide: getQueueToken(QueueName.Mail), useValue: mailQueue },
  ]);

export const theProduct = aProduct({ name: 'Analytical Engine tee' });
export const theCover = anImage(theProduct.id);
export const theVariantImage = anImage(theProduct.id);

/**
 * The row `dispatch` loads, in the exact shape of its `include`: the
 * variant's own image, and the product with its images already ordered by
 * ascending id. Assembling it here rather than in each case is what stops a
 * stub from being written against a nesting the query does not produce.
 */
export const aLoadedSku = (
  overrides: {
    stock?: number;
    reserved?: number;
    restockCycle?: number;
    imageId?: string | null;
    image?: { s3Key: string } | null;
    images?: { s3Key: string }[];
    deletedAt?: Date | null;
  } = {},
) => {
  const sku = aSku(theProduct.id, {
    stock: overrides.stock ?? LOW_STOCK_THRESHOLD,
    reserved: overrides.reserved ?? 0,
    restockCycle: overrides.restockCycle ?? 0,
    imageId: overrides.imageId ?? theVariantImage.id,
  });

  return {
    ...sku,
    image:
      overrides.image === undefined
        ? { s3Key: theVariantImage.s3Key }
        : overrides.image,
    product: {
      ...theProduct,
      deletedAt: overrides.deletedAt ?? null,
      images: overrides.images ?? [{ s3Key: theCover.s3Key }],
    },
  };
};

/** What `recipientsFor` selects: the liker's id and their address. */
export const aLikeRow = (email: string) => {
  const user = aUser({ email });
  return { userId: user.id, user: { email: user.email } };
};

/** An existing claim, so the idempotency stubs have something to collide with. */
export const aNotification = (
  userId: string,
  skuId: string,
  status: NotificationStatus = NotificationStatus.PENDING,
) => ({
  id: newId(),
  userId,
  skuId,
  restockCycle: 0,
  status,
  sentAt: status === NotificationStatus.SENT ? new Date() : null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/**
 * The unique violation the claim is allowed to lose on. Constructed rather
 * than thrown by a real database, because what the code branches on is the
 * code and the class, and both are stable across Prisma's own tests.
 */
export const aUniqueViolation = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: {
      modelName: 'StockNotification',
      target: ['userId', 'skuId', 'restockCycle'],
    },
  });

/**
 * Replaces `fetch` for the duration of a case, since the image is read out
 * of S3 through a presigned URL. Returns the spy so a case can decide what
 * the bucket answers — including not answering at all.
 */
export const stubFetch = (
  response: Partial<Response> & { arrayBuffer?: () => Promise<ArrayBuffer> },
): jest.SpyInstance =>
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(response as unknown as Response);

/** Bytes that stand in for a stored PNG, with its declared content type. */
export const anImageResponse = (bytes: Buffer) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'image/png' }),
  arrayBuffer: () =>
    Promise.resolve(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    ),
});

/**
 * Everything the stock notification decides, with no queue around it.
 *
 * Per CLAUDE.md every case below asserts on the call the dispatcher makes —
 * the `productLike.findMany` with its `NOT`, the `stockNotification.create`,
 * the `mail.add` and the `stockNotification.update` — and never on what the
 * mock handed back. The mock's return value only proves a fixture was
 * wired; the query proves the code asked the database the right question,
 * which for this feature is the whole of it: "liked it and has not bought
 * it" is a `where` clause and nothing else.
 *
 * Three groups matter more than the rest.
 *
 * **Who is asked for.** The purchase exclusion is the requirement most
 * easily satisfied by an almost-right query — one that excludes anybody with
 * an order, or anybody with an order for *this variant*, or that reads a
 * PENDING reservation as a purchase. None of those would look wrong in a
 * green suite.
 *
 * **Notified once.** `uq_stock_notifications_user_sku_cycle` is the whole
 * idempotency of the feature, and the claim-then-send order is what makes
 * the constraint do that job. A case that sends first and records afterwards
 * passes every other assertion here.
 *
 * **The picture is optional.** Every failure of S3 has to end in a message
 * that still goes out. The direction that would be wrong is silent: an
 * exception escaping `imageFor` retries a job whose real work is an email,
 * three times, and then discards it.
 */
describe('StockNotificationDispatcher', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mailQueue.add.mockResolvedValue({ id: 'mail-job' });
  });

  describe('the job it was handed', () => {
    it.todo('loads the sku with its image and its product images');

    it.todo('notifies nobody when the sku no longer exists');

    it.todo('notifies nobody when the product has been soft deleted');

    it.todo(
      'notifies nobody when the sku has moved to a later cycle, because the job is stale',
    );

    it.todo(
      'reports a stale cycle without throwing, so the job is not retried against the new one',
    );
  });

  describe('who is asked for', () => {
    it.todo('asks for the likes of the product the sku belongs to');

    it.todo(
      'excludes a liker who has an order for this product in a paid status',
    );

    it.todo(
      'excludes a liker who bought a different variant of the same product',
    );

    it.todo(
      'still notifies a liker whose only order for the product is PENDING',
    );

    it.todo('still notifies a liker whose order for the product was cancelled');

    it.todo('still notifies a liker whose order for the product failed');

    it.todo(
      'still notifies a liker who has bought something else entirely, from another product',
    );

    it.todo('excludes a soft-deleted account, which asked not to exist');

    it.todo('excludes an address that was never verified');
  });

  describe('notified once, which lives in the database', () => {
    it.todo(
      'creates a StockNotification row for each recipient before enqueuing their mail',
    );

    it.todo('records the row against the cycle the crossing belongs to');

    it.todo('enqueues nothing for a recipient whose row is already SENT');

    it.todo(
      'retries a recipient whose row is still PENDING, which is a run that died mid-way',
    );

    it.todo('retries a recipient whose row is FAILED');

    it.todo(
      'treats losing the unique constraint as another worker owning that recipient, not as an error',
    );

    it.todo(
      'lets a database error that is not a unique violation escape, rather than skipping a recipient',
    );

    it.todo('marks the row SENT, with a sentAt, once the mail job is accepted');

    it.todo('marks the row FAILED when the mail queue refuses the job');

    it.todo(
      'keeps going through the remaining recipients after one of them fails',
    );

    it.todo('counts what it did: candidates, notified, skipped and failed');
  });

  describe('the message it produces', () => {
    it.todo('adds one SendMail job per claimed recipient');

    it.todo('addresses each job to that recipient and to nobody else');

    it.todo('carries the low-stock kind, so the renderer picks that wording');

    it.todo('names the product, the size and the colour of the variant');

    it.todo(
      'reports what is still buyable — stock less reserved — rather than the raw stock',
    );

    it.todo('never reports a negative number of units left');

    it.todo('carries no token, because this message has nothing to prove');
  });

  describe('the product image, which must never cost a notification', () => {
    it.todo(
      'attaches the base64 of the object behind the sku image when it has one',
    );

    it.todo(
      'falls back to the product cover, the first image by ascending id, when the variant has none',
    );

    it.todo('reuses one attachment across every recipient of the crossing');

    it.todo('sends without an attachment when the product has no image at all');

    it.todo('sends without an attachment when storage answers a failure');

    it.todo('sends without an attachment when the fetch throws or times out');

    it.todo(
      'sends without an attachment when the object is larger than the cap',
    );

    it.todo(
      'never lets a storage failure reach the processor, where it would retry the whole fan-out',
    );

    it.todo('reports in its outcome whether the image made it in');
  });
});
