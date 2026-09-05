import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationStatus, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { availableOf } from '../catalog/views';
import { newId } from '../common/ids';
import {
  MailKind,
  type MailAttachment,
  type MailJobData,
} from '../mail/mail.jobs';
import { PrismaService } from '../prisma/prisma.service';
import { JobName, QueueName } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { loadImageAttachment } from './product-image.attachment';
import type {
  StockNotificationJobData,
  StockNotificationOutcome,
} from './stock-notification.jobs';
import { PURCHASED_ORDER_STATUSES } from './stock-threshold';

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === UNIQUE_VIOLATION;

/** The message of anything thrown, without assuming it is an `Error`. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the SKU's row has to bring with it to build one message. */
const SKU_INCLUDE = {
  image: true,
  product: { include: { images: { orderBy: { id: Prisma.SortOrder.asc } } } },
} satisfies Prisma.SkuInclude;

/**
 * Everything the stock notification actually does, kept out of the
 * processor so it can be exercised without a queue around it — the same
 * split `mail.content.ts` makes, for the same reason.
 *
 * The order of operations is the feature. Recipients are resolved, then each
 * one is **claimed in the database**, and only a claim that succeeded
 * produces a mail job. Claiming first is what makes the run idempotent: two
 * workers on the same crossing, or the same job retried after a crash, race
 * on `uq_stock_notifications_user_sku_cycle` and exactly one of them wins
 * each recipient. Sending first and recording afterwards would send twice
 * and record once.
 */
@Injectable()
export class StockNotificationDispatcher {
  private readonly logger = new Logger(StockNotificationDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue(QueueName.Mail) private readonly mail: Queue<MailJobData>,
  ) {}

  async dispatch(
    data: StockNotificationJobData,
  ): Promise<StockNotificationOutcome> {
    const nothing: StockNotificationOutcome = {
      candidates: 0,
      notified: 0,
      skipped: 0,
      failed: 0,
      withImage: false,
    };

    const sku = await this.prisma.sku.findUnique({
      where: { id: data.skuId },
      include: SKU_INCLUDE,
    });

    // A SKU that has gone, or a product soft deleted underneath it. Neither
    // is an error worth retrying: there is nothing left to advertise.
    if (!sku || sku.product.deletedAt !== null) {
      this.logger.warn(
        `Sku ${data.skuId} is gone or its product was deleted; nothing to notify.`,
      );
      return nothing;
    }

    // The SKU was restocked while the job waited. The crossing this job
    // describes belongs to a cycle that has closed, and notifying now would
    // tell people a product is running low that has just been refilled.
    if (sku.restockCycle !== data.restockCycle) {
      this.logger.log(
        `Sku ${data.skuId} moved to cycle ${sku.restockCycle}; the job for cycle ${data.restockCycle} is stale.`,
      );
      return nothing;
    }

    const candidates = await this.recipientsFor(sku.productId);
    const attachment = await this.imageFor(sku);
    const outcome: StockNotificationOutcome = {
      ...nothing,
      candidates: candidates.length,
      withImage: attachment !== undefined,
    };

    for (const candidate of candidates) {
      const claimed = await this.claim(
        candidate.userId,
        sku.id,
        sku.restockCycle,
      );

      if (!claimed) {
        outcome.skipped += 1;
        continue;
      }

      try {
        await this.mail.add(JobName.SendMail, {
          kind: MailKind.LowStock,
          to: candidate.email,
          lowStock: {
            productName: sku.product.name,
            size: sku.size,
            color: sku.color,
            remaining: Math.max(availableOf(sku), 0),
          },
          ...(attachment ? { attachments: [attachment] } : {}),
        });

        await this.prisma.stockNotification.update({
          where: { id: claimed },
          data: { status: NotificationStatus.SENT, sentAt: new Date() },
        });
        outcome.notified += 1;
      } catch (error) {
        // The row stays, in FAILED rather than PENDING, so a later run can
        // tell "nobody has tried this one" from "this one was tried and the
        // queue refused it". The recipient never appears in the log line.
        await this.prisma.stockNotification.update({
          where: { id: claimed },
          data: { status: NotificationStatus.FAILED },
        });
        outcome.failed += 1;
        this.logger.error(
          `Could not enqueue the low-stock mail for sku ${sku.id}: ${describe(error)}`,
        );
      }
    }

    this.logger.log(
      `Sku ${sku.id} cycle ${sku.restockCycle}: ${outcome.candidates} candidate(s), ${outcome.notified} notified, ${outcome.skipped} already notified, ${outcome.failed} failed.`,
    );

    return outcome;
  }

  /**
   * Liked the product, has not bought it, and can still be written to.
   *
   * The like is per product and the crossing is per SKU, which is the
   * fan-out finding 11 of docs/DESIGN-ATTACK.md describes — under this
   * reading it does not bite, because a sale takes one variant across the
   * threshold at a time rather than a restock taking all forty-eight at
   * once, and the message can therefore say *which* variant is running out.
   *
   * "Has not bought it" is about the **product**, not this variant: somebody
   * who owns the black medium already bought the thing they liked, and
   * telling them the navy large is nearly gone is a different message from
   * the one the brief asks for.
   *
   * Two filters on the user are not in the brief and are here anyway. A
   * soft-deleted account has asked not to exist, and `liveEmail` is nulled
   * out for it, so writing to `email` would be reaching around the deletion.
   * An unverified address has never been proven to belong to the person who
   * typed it, and the point of the verification flow is that nothing else is
   * sent there.
   */
  private async recipientsFor(
    productId: string,
  ): Promise<{ userId: string; email: string }[]> {
    const likes = await this.prisma.productLike.findMany({
      where: {
        productId,
        user: {
          deletedAt: null,
          emailVerifiedAt: { not: null },
          // `some` over the liker's orders, negated: no order of theirs that
          // reached a paid status carries a line for any SKU of this
          // product. Written as NOT-some rather than `none` so both
          // conditions stay inside one subquery — `none` with two nested
          // filters reads as a different and weaker question.
          NOT: {
            orders: {
              some: {
                status: { in: [...PURCHASED_ORDER_STATUSES] },
                items: { some: { sku: { productId } } },
              },
            },
          },
        },
      },
      select: { userId: true, user: { select: { email: true } } },
      orderBy: { id: Prisma.SortOrder.asc },
    });

    return likes.map((like) => ({
      userId: like.userId,
      email: like.user.email,
    }));
  }

  /**
   * The variant's own photograph when it has one, and the product's cover
   * otherwise — `uq_product_images_id_product` guarantees the first belongs
   * to the same product, and the cover is the first image by ascending
   * UUIDv7, which is upload order.
   *
   * Every failure here is swallowed on purpose. A product with no image at
   * all, a bucket that is unreachable, an object that is too large: none is
   * a reason to withhold the message, and none is a reason to retry a job
   * whose real work is an email. The reason is logged and the send goes on
   * without a picture.
   */
  private async imageFor(sku: {
    image: { s3Key: string } | null;
    product: { images: { s3Key: string }[] };
  }): Promise<MailAttachment | undefined> {
    const key = sku.image?.s3Key ?? sku.product.images[0]?.s3Key;

    if (!key) {
      this.logger.warn('The product has no image; sending without one.');
      return undefined;
    }

    try {
      return await loadImageAttachment(this.storage, key);
    } catch (error) {
      this.logger.warn(`Sending without the product image: ${describe(error)}`);
      return undefined;
    }
  }

  /**
   * Takes ownership of one recipient for one crossing, or answers that
   * somebody else already has it.
   *
   * A row that exists and is SENT is done. A row that exists in PENDING or
   * FAILED is one an earlier run created and never finished — the worker
   * died between the claim and the enqueue, or the enqueue was refused — and
   * that is precisely the case a retry should pick up, so its id comes back.
   *
   * The read cannot be trusted on its own: two workers reach it at the same
   * moment, both see nothing, and both create. `create` is therefore allowed
   * to lose, and losing on `uq_stock_notifications_user_sku_cycle` is the
   * answer "the other one owns this recipient", not an error.
   */
  private async claim(
    userId: string,
    skuId: string,
    restockCycle: number,
  ): Promise<string | null> {
    const existing = await this.prisma.stockNotification.findUnique({
      where: { userId_skuId_restockCycle: { userId, skuId, restockCycle } },
    });

    if (existing) {
      return existing.status === NotificationStatus.SENT ? null : existing.id;
    }

    try {
      const created = await this.prisma.stockNotification.create({
        data: { id: newId(), userId, skuId, restockCycle },
      });
      return created.id;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }
}
