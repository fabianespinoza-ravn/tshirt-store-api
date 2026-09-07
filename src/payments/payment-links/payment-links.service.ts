import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PaymentLink } from '@prisma/client';
import { NOT_DELETED } from '../../catalog/query';
import { newId } from '../../common/ids';
import { loadOrThrow } from '../../common/load-or-throw';
import { Problems } from '../../common/problem/problem.catalog';
import { ProblemException } from '../../common/problem/problem.exception';
import {
  GENERIC_INTERNAL_DETAIL,
  translateStripeError,
} from '../../common/problem/translators';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from '../stripe.service';
import type { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { toPaymentLink, type PaymentLinkView } from './payment-links.views';

/** Either the service's client or the one inside `$transaction`. */
type PrismaLike = PrismaService | Prisma.TransactionClient;

/**
 * The link, and whether this request is the one that created it.
 *
 * `created` exists because the matrix gives `createPaymentLink` two success
 * codes, 200 and 201, and nothing else in that row explains a second one.
 * The reading taken here is the one those codes describe: a SKU has at most
 * one active link, so asking for a link it already has is not an error to
 * refuse, it is a request that was already satisfied — 200 with the existing
 * link. Only the request that actually publishes one answers 201.
 */
export interface CreatedPaymentLink {
  link: PaymentLinkView;
  created: boolean;
}

@Injectable()
export class PaymentLinksService {
  private readonly logger = new Logger(PaymentLinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async deactivateForSku(skuId: string): Promise<void> {
    const links = await this.prisma.paymentLink.findMany({
      where: { skuId, isActive: true },
      select: { id: true, stripePaymentLinkId: true },
    });

    await this.deactivateLinks(links);
  }

  async deactivateForProduct(productId: string): Promise<void> {
    const links = await this.prisma.paymentLink.findMany({
      where: { sku: { productId }, isActive: true },
      select: { id: true, stripePaymentLinkId: true },
    });

    await this.deactivateLinks(links);
  }

  private async deactivateLinks(
    links: Pick<PaymentLink, 'id' | 'stripePaymentLinkId'>[],
  ): Promise<void> {
    for (const link of links) {
      try {
        const deactivated = await this.stripe.deactivatePaymentLink(
          link.stripePaymentLinkId,
        );

        if (!deactivated) {
          this.logger.error(
            `Stripe did not deactivate payment link ${link.id} (${link.stripePaymentLinkId}).`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Could not deactivate payment link ${link.id} (${link.stripePaymentLinkId}): ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }

      await this.prisma.paymentLink.updateMany({
        where: { id: link.id, isActive: true },
        data: { isActive: false },
      });
    }
  }

  /**
   * Publishes a Payment Link for one SKU, or hands back the one it has.
   *
   * Three things happen in a fixed order, and the order is the design:
   *
   * 1. The SKU is read and its active link, if any, is returned unchanged.
   *    Nothing reaches Stripe in that case.
   * 2. Stripe creates the link. **Outside any transaction**, for the reason
   *    `OrdersService.startPayment` gives: an HTTP round trip inside a
   *    `Serializable` transaction turns a third party's latency into this
   *    database's contention.
   * 3. The row is written inside a `Serializable` transaction that looks for
   *    an active link once more. Being outside the transaction in step 2
   *    opens a window, and this is where the window is closed.
   *
   * What the second look costs when it finds something is a link that exists
   * at Stripe and in no row of ours, and that is the one outcome worth
   * cleaning up: a live URL nothing here can see, which anyone who obtained
   * it could pay through while the settlement handler had no `PaymentLink`
   * row to recognise the session by. So the loser is deactivated at Stripe,
   * and the winner's link is what the caller receives.
   *
   * The partial unique index `UNIQUE (sku_id) WHERE is_active` is still
   * pending in `prisma/schema.prisma`, so this is the whole enforcement of
   * one-active-link-per-SKU today. When the index lands it becomes the
   * backstop and this stays the explained answer, exactly as
   * `uq_carts_user_active` and the cart already sit.
   */
  async create(dto: CreatePaymentLinkDto): Promise<CreatedPaymentLink> {
    const sku = await loadOrThrow(
      () =>
        this.prisma.sku.findFirst({
          where: { id: dto.skuId, product: NOT_DELETED },
          include: { product: true },
        }),
      'The variant does not exist, or its product has been deleted.',
    );

    if (!sku.product.isActive) {
      throw new ProblemException(
        Problems.notFound,
        'The variant belongs to a product that is not for sale.',
      );
    }

    const existing = await this.activeLinkFor(this.prisma, sku.id);
    if (existing) return { link: toPaymentLink(existing), created: false };

    // Generated before the call so it can be the idempotency key, and so the
    // row about to be written and the Stripe request share one identity.
    //
    // What that key does and does not cover is worth being exact about. It
    // makes the SDK's own retries — and a duplicate delivery of this one HTTP
    // call — resolve to a single Stripe link. It does **not** cover a client
    // retrying the POST after a timeout: that is a new invocation, so a new
    // id, so a second Stripe link. The first one is not lost, because it was
    // recorded before anything could answer the client; the second is the
    // orphan the `catch` below exists for. A key derived from the SKU would
    // cover the client retry and break the case that matters more — a SKU
    // must be able to get a new link at a new price after the old one is
    // deactivated, and Stripe refuses a reused key whose parameters changed.
    const id = newId();
    // Frozen here, and this is `unitPriceAtCreation`'s whole purpose. The
    // amount below is the amount that goes to Stripe; a price edit arriving
    // a millisecond later changes what the catalogue sells for and must not
    // change what this already-published link charges.
    const unitPriceAtCreation = sku.price;

    const link = await this.createAtStripe({
      requestId: id,
      skuId: sku.id,
      productName: sku.product.name,
      unitAmount: unitPriceAtCreation,
    });

    let settled: { row: PaymentLink; created: boolean };

    try {
      settled = await this.prisma.$transaction(
        async (tx) => {
          const raced = await this.activeLinkFor(tx, sku.id);
          if (raced) return { row: raced, created: false };

          const row = await tx.paymentLink.create({
            data: {
              id,
              skuId: sku.id,
              stripePaymentLinkId: link.id,
              url: link.url,
              unitPriceAtCreation,
              isActive: true,
            },
          });

          return { row, created: true };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      // **The invariant this catch protects: every payable link at Stripe has
      // a row here.** Without it, a rejected transaction — P2034 against a
      // concurrent create for the same SKU is the case the docblock
      // anticipates — leaves link `link.id` live and payable while nothing
      // records it. A buyer who obtained that URL would pay, and settlement
      // would look the id up, find nothing, and correctly answer "not mine":
      // money taken, no order, and an acknowledged event Stripe never
      // redelivers.
      //
      // Turning the link off is what closes that. It runs before anything
      // else, and its own failure is logged inside the seam rather than
      // replacing whatever the caller ends up being told.
      await this.stripe.deactivatePaymentLink(link.id);

      // Losing that race is not a server error, and answering 500 for it was
      // wrong: the contract for "this SKU already has a link" is 200 with the
      // link, and after a concurrent create the SKU *does* have one. The
      // caller asked for the SKU's active link and there is one to give, so
      // it is given, with `created: false` saying this request is not the one
      // that made it. Only an SKU left with no link at all is a real failure,
      // and that error is re-raised untouched.
      const winner = await this.activeLinkFor(this.prisma, sku.id);

      if (winner) {
        return { link: toPaymentLink(winner), created: false };
      }

      throw error;
    }

    // The other way to end up with an orphan, and the quiet one: this request
    // lost the race inside the transaction, so its link was never written
    // down. A refusal to deactivate is logged inside the seam and
    // deliberately does not change the answer — the caller asked for the
    // SKU's active link and is getting it either way, and turning a
    // successful response into a 503 over an orphan we have already logged
    // would help nobody.
    if (!settled.created) await this.stripe.deactivatePaymentLink(link.id);

    return { link: toPaymentLink(settled.row), created: settled.created };
  }

  /**
   * The SKU's live link, or null.
   *
   * Two links for one SKU are not merely untidy: they can carry different
   * prices, and `PaymentLink.unitPriceAtCreation` is what the settlement
   * handler writes the order at. A buyer could then be shown one price and
   * an order written at another, with nothing in the system able to say
   * which link was meant.
   */
  private activeLinkFor(client: PrismaLike, skuId: string) {
    return client.paymentLink.findFirst({ where: { skuId, isActive: true } });
  }

  /**
   * The Stripe call, with its failures classified into the catalog.
   *
   * `common/problem/translators/stripe.translator.ts` carries the reasoning
   * and does the classifying; the short version is that Stripe's status code
   * is never ours. Nothing here shapes a response —
   * `problem-details.filter.ts` remains the only place that does — this only
   * picks which entry of `Problems` the exception carries.
   *
   * The same translator is registered in the registry, so a Stripe error
   * that reaches the filter by any other route is classified identically.
   * Raising it here rather than letting it bubble buys one thing: this
   * method logs which SKU the refusal was for, which the filter cannot know.
   * The `??` is the honest fallback — an error the translator declines is
   * one it could not attribute to Stripe, and an unattributable failure is
   * the generic 500 it already was.
   */
  private async createAtStripe(params: {
    requestId: string;
    skuId: string;
    productName: string;
    unitAmount: number;
  }) {
    try {
      return await this.stripe.createPaymentLink(params);
    } catch (error) {
      this.logger.error(
        `Stripe refused a payment link for SKU ${params.skuId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );

      const translation = translateStripeError(error) ?? {
        kind: Problems.internalError,
        detail: GENERIC_INTERNAL_DETAIL,
      };

      throw new ProblemException(translation.kind, translation.detail);
    }
  }
}
