import { getQueueToken } from '@nestjs/bullmq';

/* Jest's asymmetric matchers are typed as `any`; these are partial checks of
 * Prisma calls and are never values passed to production code. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { NotificationStatus, OrderStatus, Prisma } from '@prisma/client';
import { newId } from '../common/ids';
import { MailKind, type MailJobData } from '../mail/mail.jobs';
import { JobName, QueueName } from '../queue/queue.constants';
import { buildService, type ServiceHarness } from '../testing/build-service';
import { aProduct, aSku, anImage, aUser } from '../testing/factories';
import { MAX_ATTACHMENT_BYTES } from './product-image.attachment';
import { StockNotificationDispatcher } from './stock-notification.dispatcher';
import {
  LOW_STOCK_THRESHOLD,
  PURCHASED_ORDER_STATUSES,
} from './stock-threshold';

/** Stands in for `QueueName.Mail`, which the dispatcher produces onto. */
export const mailQueue = {
  add: jest.fn<Promise<{ id: string }>, [name: string, data: MailJobData]>(),
};

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
 * the bucket answers — including not answering at all, which is why an
 * `Error` is as acceptable an argument as a response.
 */
export const stubFetch = (response: Partial<Response> | Error) => {
  const spy = jest.spyOn(globalThis, 'fetch');
  return response instanceof Error
    ? spy.mockRejectedValue(response)
    : spy.mockResolvedValue(response as unknown as Response);
};

/**
 * Bytes that stand in for a stored PNG, with its declared content type.
 *
 * The body is a stream and not one finished buffer because that is what
 * `loadImageAttachment` reads: it counts the bytes as they arrive so that an
 * object over `MAX_ATTACHMENT_BYTES` is never assembled, and a double that
 * handed it the whole object at once would not exercise that.
 *
 * No `Content-Length` is declared, which is the honest default: S3 sets one
 * and an intermediary need not, and the cap has to hold either way.
 */
export const anImageResponse = (bytes: Buffer) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'image/png' }),
  body: new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      const chunk = 64 * 1024;
      for (let at = 0; at < bytes.byteLength; at += chunk) {
        controller.enqueue(new Uint8Array(bytes.subarray(at, at + chunk)));
      }
      controller.close();
    },
  }),
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
  let h: ServiceHarness<StockNotificationDispatcher>;

  /** The stored object the happy path reads out of the bucket. */
  const theBytes = Buffer.from('the photograph', 'utf8');

  const theLiker = aLikeRow('liker@example.test');
  const anotherLiker = aLikeRow('other-liker@example.test');

  /**
   * The ordinary run: the sku is there, one liker wants it, nobody has been
   * claimed yet and the bucket answers. Every case below overrides exactly
   * the one thing it is about.
   */
  const prime = (
    options: {
      sku?: ReturnType<typeof aLoadedSku>;
      likes?: ReturnType<typeof aLikeRow>[];
    } = {},
  ): void => {
    h.prisma.sku.findUnique.mockResolvedValue(options.sku ?? aLoadedSku());
    h.prisma.productLike.findMany.mockResolvedValue(
      (options.likes ?? [theLiker]) as never,
    );
    h.prisma.stockNotification.findUnique.mockResolvedValue(null);
    h.prisma.stockNotification.create.mockResolvedValue({
      id: 'claim-1',
    } as never);
    h.prisma.stockNotification.update.mockResolvedValue({} as never);
    stubFetch(anImageResponse(theBytes));
  };

  /** The job the producer would have enqueued for the crossing. */
  const theJob = (restockCycle = 0) => ({
    skuId: 'sku-under-test',
    restockCycle,
  });

  /** The payloads handed to the mail queue, typed rather than `any`. */
  const mailJobs = (): MailJobData[] =>
    mailQueue.add.mock.calls.map((call) => call[1]);

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mailQueue.add.mockResolvedValue({ id: 'mail-job' });
    h = await buildDispatcherHarness();
  });

  describe('the job it was handed', () => {
    it('loads the sku with its image and its product images', async () => {
      prime();

      await h.service.dispatch({ skuId: 'sku-under-test', restockCycle: 0 });

      expect(h.prisma.sku.findUnique).toHaveBeenCalledWith({
        where: { id: 'sku-under-test' },
        include: {
          image: true,
          product: {
            include: { images: { orderBy: { id: Prisma.SortOrder.asc } } },
          },
        },
      });
    });

    it('notifies nobody when the sku no longer exists', async () => {
      prime();
      h.prisma.sku.findUnique.mockResolvedValue(null);

      const outcome = await h.service.dispatch(theJob());

      expect(outcome).toEqual({
        candidates: 0,
        notified: 0,
        skipped: 0,
        failed: 0,
        withImage: false,
      });
      expect(h.prisma.productLike.findMany).not.toHaveBeenCalled();
      expect(mailQueue.add).not.toHaveBeenCalled();
    });

    it('notifies nobody when the product has been soft deleted', async () => {
      prime({ sku: aLoadedSku({ deletedAt: new Date() }) });

      const outcome = await h.service.dispatch(theJob());

      expect(outcome.candidates).toBe(0);
      expect(h.prisma.productLike.findMany).not.toHaveBeenCalled();
      expect(mailQueue.add).not.toHaveBeenCalled();
    });

    it('notifies nobody when the sku has moved to a later cycle, because the job is stale', async () => {
      prime({ sku: aLoadedSku({ restockCycle: 2 }) });

      const outcome = await h.service.dispatch(theJob(1));

      expect(outcome.candidates).toBe(0);
      expect(h.prisma.productLike.findMany).not.toHaveBeenCalled();
      expect(h.prisma.stockNotification.create).not.toHaveBeenCalled();
      expect(mailQueue.add).not.toHaveBeenCalled();
    });

    it('reports a stale cycle without throwing, so the job is not retried against the new one', async () => {
      prime({ sku: aLoadedSku({ restockCycle: 2 }) });

      await expect(h.service.dispatch(theJob(1))).resolves.toEqual({
        candidates: 0,
        notified: 0,
        skipped: 0,
        failed: 0,
        withImage: false,
      });
    });
  });

  describe('who is asked for', () => {
    it('asks for the likes of the product the sku belongs to', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.productLike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ productId: theProduct.id }),
          // Two columns and no more: the recipient list is personal data
          // and the row it is built from should carry nothing else.
          select: { userId: true, user: { select: { email: true } } },
          orderBy: { id: Prisma.SortOrder.asc },
        }),
      );
    });

    it('restricts those likes to accounts that are neither soft deleted nor unverified and have no paid order for the product', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.productLike.findMany).toHaveBeenCalledWith({
        where: {
          productId: theProduct.id,
          user: {
            deletedAt: null,
            emailVerifiedAt: { not: null },
            NOT: {
              orders: {
                some: {
                  status: { in: [...PURCHASED_ORDER_STATUSES] },
                  items: { some: { sku: { productId: theProduct.id } } },
                },
              },
            },
          },
        },
        select: { userId: true, user: { select: { email: true } } },
        orderBy: { id: Prisma.SortOrder.asc },
      });
    });

    it('excludes a liker who has an order for this product in a paid status', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.productLike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({
              NOT: {
                orders: {
                  some: expect.objectContaining({
                    status: { in: [...PURCHASED_ORDER_STATUSES] },
                    items: { some: { sku: { productId: theProduct.id } } },
                  }),
                },
              },
            }),
          }),
        }),
      );
    });

    it('excludes a liker who bought a different variant of the same product', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.productLike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({
              NOT: expect.objectContaining({
                orders: expect.objectContaining({
                  some: expect.objectContaining({
                    items: { some: { sku: { productId: theProduct.id } } },
                  }),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it('still notifies a liker whose only order for the product is PENDING', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.productLike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({
              NOT: expect.objectContaining({
                orders: expect.objectContaining({
                  some: expect.objectContaining({
                    status: {
                      in: expect.not.arrayContaining([OrderStatus.PENDING]),
                    },
                  }),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it('still notifies a liker whose order for the product was cancelled', async () => {
      prime();

      await h.service.dispatch(theJob());

      const [call] = h.prisma.productLike.findMany.mock.calls;
      expect(call?.[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({
              NOT: expect.objectContaining({
                orders: expect.objectContaining({
                  some: expect.objectContaining({
                    status: {
                      in: expect.not.arrayContaining([OrderStatus.CANCELLED]),
                    },
                  }),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it('still notifies a liker whose order for the product failed', async () => {
      prime();

      await h.service.dispatch(theJob());

      const [call] = h.prisma.productLike.findMany.mock.calls;
      expect(call?.[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({
              NOT: expect.objectContaining({
                orders: expect.objectContaining({
                  some: expect.objectContaining({
                    status: {
                      in: expect.not.arrayContaining([OrderStatus.FAILED]),
                    },
                  }),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it('still notifies a liker who has bought something else entirely, from another product', async () => {
      prime();

      await h.service.dispatch(theJob());

      const [call] = h.prisma.productLike.findMany.mock.calls;
      expect(call?.[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            productId: theProduct.id,
            user: expect.objectContaining({
              NOT: expect.objectContaining({
                orders: expect.objectContaining({
                  some: expect.objectContaining({
                    items: { some: { sku: { productId: theProduct.id } } },
                  }),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it('excludes a soft-deleted account, which asked not to exist', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.productLike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({ deletedAt: null }),
          }),
        }),
      );
    });

    it('excludes an address that was never verified', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.productLike.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({ emailVerifiedAt: { not: null } }),
          }),
        }),
      );
    });
  });

  describe('notified once, which lives in the database', () => {
    it('creates a StockNotification row for each recipient before enqueuing their mail', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.stockNotification.create).toHaveBeenCalledTimes(1);
      expect(mailQueue.add).toHaveBeenCalledTimes(1);
      expect(
        h.prisma.stockNotification.create.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mailQueue.add.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    });

    it('records the row against the cycle the crossing belongs to', async () => {
      const sku = aLoadedSku({ restockCycle: 7 });
      prime({ sku });

      await h.service.dispatch(theJob(7));

      expect(h.prisma.stockNotification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: theLiker.userId,
          skuId: sku.id,
          restockCycle: 7,
        }),
      });
    });

    it('enqueues nothing for a recipient whose row is already SENT', async () => {
      prime();
      h.prisma.stockNotification.findUnique.mockResolvedValue(
        aNotification(
          theLiker.userId,
          'sku-under-test',
          NotificationStatus.SENT,
        ),
      );

      await expect(h.service.dispatch(theJob())).resolves.toEqual(
        expect.objectContaining({ candidates: 1, notified: 0, skipped: 1 }),
      );
      expect(mailQueue.add).not.toHaveBeenCalled();
      expect(h.prisma.stockNotification.create).not.toHaveBeenCalled();
    });

    it('retries a recipient whose row is still PENDING, which is a run that died mid-way', async () => {
      prime();
      h.prisma.stockNotification.findUnique.mockResolvedValue(
        aNotification(
          theLiker.userId,
          'sku-under-test',
          NotificationStatus.PENDING,
        ),
      );

      const outcome = await h.service.dispatch(theJob());

      expect(outcome.notified).toBe(1);
      expect(mailQueue.add).toHaveBeenCalledTimes(1);
      expect(h.prisma.stockNotification.create).not.toHaveBeenCalled();
    });

    it('retries a recipient whose row is FAILED', async () => {
      prime();
      h.prisma.stockNotification.findUnique.mockResolvedValue(
        aNotification(
          theLiker.userId,
          'sku-under-test',
          NotificationStatus.FAILED,
        ),
      );

      const outcome = await h.service.dispatch(theJob());

      expect(outcome.notified).toBe(1);
      expect(mailQueue.add).toHaveBeenCalledTimes(1);
      expect(h.prisma.stockNotification.create).not.toHaveBeenCalled();
    });

    it('treats losing the unique constraint as another worker owning that recipient, not as an error', async () => {
      prime();
      h.prisma.stockNotification.create.mockRejectedValue(aUniqueViolation());

      await expect(h.service.dispatch(theJob())).resolves.toEqual(
        expect.objectContaining({
          candidates: 1,
          notified: 0,
          skipped: 1,
          failed: 0,
        }),
      );
      expect(mailQueue.add).not.toHaveBeenCalled();
    });

    it('lets a database error that is not a unique violation escape, rather than skipping a recipient', async () => {
      prime();
      h.prisma.stockNotification.create.mockRejectedValue(
        new Error('database unavailable'),
      );

      await expect(h.service.dispatch(theJob())).rejects.toThrow(
        'database unavailable',
      );
      expect(mailQueue.add).not.toHaveBeenCalled();
    });

    it('marks the row SENT, with a sentAt, once the mail job is accepted', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.prisma.stockNotification.update).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: { status: NotificationStatus.SENT, sentAt: expect.any(Date) },
      });
    });

    it('marks the row FAILED when the mail queue refuses the job', async () => {
      prime();
      mailQueue.add.mockRejectedValue(new Error('queue unavailable'));

      const outcome = await h.service.dispatch(theJob());

      expect(outcome).toEqual(
        expect.objectContaining({ notified: 0, failed: 1 }),
      );
      expect(h.prisma.stockNotification.update).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: { status: NotificationStatus.FAILED },
      });
    });

    it('keeps going through the remaining recipients after one of them fails', async () => {
      prime({ likes: [theLiker, anotherLiker] });
      h.prisma.stockNotification.create
        .mockResolvedValueOnce({ id: 'claim-1' } as never)
        .mockResolvedValueOnce({ id: 'claim-2' } as never);
      mailQueue.add
        .mockRejectedValueOnce(new Error('first recipient failed'))
        .mockResolvedValueOnce({ id: 'mail-2' });

      const outcome = await h.service.dispatch(theJob());

      expect(outcome).toEqual(
        expect.objectContaining({ candidates: 2, notified: 1, failed: 1 }),
      );
      expect(mailQueue.add).toHaveBeenCalledTimes(2);
      expect(h.prisma.stockNotification.update).toHaveBeenCalledWith({
        where: { id: 'claim-2' },
        data: { status: NotificationStatus.SENT, sentAt: expect.any(Date) },
      });
    });

    it('counts what it did: candidates, notified, skipped and failed', async () => {
      prime({ likes: [theLiker, anotherLiker] });
      h.prisma.stockNotification.findUnique
        .mockResolvedValueOnce(
          aNotification(
            theLiker.userId,
            'sku-under-test',
            NotificationStatus.SENT,
          ),
        )
        .mockResolvedValueOnce(null);

      await expect(h.service.dispatch(theJob())).resolves.toEqual(
        expect.objectContaining({
          candidates: 2,
          notified: 1,
          skipped: 1,
          failed: 0,
        }),
      );
    });
  });

  describe('the message it produces', () => {
    it('adds one SendMail job per claimed recipient', async () => {
      prime({ likes: [theLiker, anotherLiker] });

      await h.service.dispatch(theJob());

      expect(mailQueue.add).toHaveBeenCalledTimes(2);
      expect(mailQueue.add.mock.calls.map((call) => call[0])).toEqual([
        JobName.SendMail,
        JobName.SendMail,
      ]);
    });

    it('addresses each job to that recipient and to nobody else', async () => {
      prime({ likes: [theLiker, anotherLiker] });

      await h.service.dispatch(theJob());

      expect(mailJobs().map((job) => job.to)).toEqual([
        'liker@example.test',
        'other-liker@example.test',
      ]);
    });

    it('carries the low-stock kind, so the renderer picks that wording', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(mailJobs()[0]?.kind).toBe(MailKind.LowStock);
    });

    it('names the product, the size and the colour of the variant', async () => {
      const sku = aLoadedSku();
      prime({ sku });

      await h.service.dispatch(theJob());

      expect(mailJobs()[0]?.lowStock).toEqual(
        expect.objectContaining({
          productName: theProduct.name,
          size: sku.size,
          color: sku.color,
        }),
      );
    });

    it('reports what is still buyable — stock less reserved — rather than the raw stock', async () => {
      prime({ sku: aLoadedSku({ stock: LOW_STOCK_THRESHOLD, reserved: 1 }) });

      await h.service.dispatch(theJob());

      expect(mailJobs()[0]?.lowStock?.remaining).toBe(LOW_STOCK_THRESHOLD - 1);
    });

    it('never reports a negative number of units left', async () => {
      prime({ sku: aLoadedSku({ stock: 1, reserved: 4 }) });

      await h.service.dispatch(theJob());

      expect(mailJobs()[0]?.lowStock?.remaining).toBe(0);
    });

    it('carries no token, because this message has nothing to prove', async () => {
      prime();

      await h.service.dispatch(theJob());

      const job = mailJobs()[0];
      expect(job).toBeDefined();
      expect(job && 'token' in job).toBe(false);
      expect(Object.keys(job ?? {}).sort()).toEqual([
        'attachments',
        'kind',
        'lowStock',
        'to',
      ]);
    });
  });

  describe('the product image, which must never cost a notification', () => {
    it('attaches the base64 of the object behind the sku image when it has one', async () => {
      prime();

      await h.service.dispatch(theJob());

      expect(h.storage.urlFor).toHaveBeenCalledWith(theVariantImage.s3Key);
      expect(mailJobs()[0]?.attachments).toEqual([
        {
          filename: `${theVariantImage.id}.png`,
          content: theBytes.toString('base64'),
          contentType: 'image/png',
        },
      ]);
    });

    it('falls back to the product cover, the first image by ascending id, when the variant has none', async () => {
      prime({
        sku: aLoadedSku({
          image: null,
          imageId: null,
          images: [
            { s3Key: theCover.s3Key },
            { s3Key: 'products/p/later.png' },
          ],
        }),
      });

      await h.service.dispatch(theJob());

      expect(h.storage.urlFor).toHaveBeenCalledTimes(1);
      expect(h.storage.urlFor).toHaveBeenCalledWith(theCover.s3Key);
    });

    it('reuses one attachment across every recipient of the crossing', async () => {
      prime({ likes: [theLiker, anotherLiker] });

      await h.service.dispatch(theJob());

      // Read once, not once per liker: the fan-out is the reason the object
      // is bounded in size at all.
      expect(h.storage.urlFor).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const [first, second] = mailJobs();
      expect(first?.attachments?.[0]).toBe(second?.attachments?.[0]);
    });

    it('sends without an attachment when the product has no image at all', async () => {
      prime({ sku: aLoadedSku({ image: null, imageId: null, images: [] }) });

      await h.service.dispatch(theJob());

      expect(h.storage.urlFor).not.toHaveBeenCalled();
      expect(mailQueue.add).toHaveBeenCalledTimes(1);
      expect(mailJobs()[0]?.attachments).toBeUndefined();
    });

    it('sends without an attachment when storage answers a failure', async () => {
      prime();
      stubFetch({ ok: false, status: 500, headers: new Headers() });

      await h.service.dispatch(theJob());

      expect(mailQueue.add).toHaveBeenCalledTimes(1);
      expect(mailJobs()[0]?.attachments).toBeUndefined();
    });

    it('sends without an attachment when the fetch throws or times out', async () => {
      prime();
      stubFetch(new Error('The operation was aborted due to timeout'));

      await h.service.dispatch(theJob());

      expect(mailQueue.add).toHaveBeenCalledTimes(1);
      expect(mailJobs()[0]?.attachments).toBeUndefined();
    });

    it('sends without an attachment when the object is larger than the cap', async () => {
      prime();
      stubFetch(anImageResponse(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x2a)));

      await h.service.dispatch(theJob());

      expect(mailQueue.add).toHaveBeenCalledTimes(1);
      expect(mailJobs()[0]?.attachments).toBeUndefined();
    });

    it('never lets a storage failure reach the processor, where it would retry the whole fan-out', async () => {
      prime();
      h.storage.urlFor.mockRejectedValue(new Error('S3 is unreachable'));

      await expect(h.service.dispatch(theJob())).resolves.toEqual(
        expect.objectContaining({ notified: 1, withImage: false }),
      );
      expect(mailQueue.add).toHaveBeenCalledTimes(1);
    });

    it('reports in its outcome whether the image made it in', async () => {
      prime();

      await expect(h.service.dispatch(theJob())).resolves.toEqual(
        expect.objectContaining({ withImage: true }),
      );

      jest.clearAllMocks();
      prime({ sku: aLoadedSku({ image: null, imageId: null, images: [] }) });

      await expect(h.service.dispatch(theJob())).resolves.toEqual(
        expect.objectContaining({ withImage: false }),
      );
    });
  });
});
