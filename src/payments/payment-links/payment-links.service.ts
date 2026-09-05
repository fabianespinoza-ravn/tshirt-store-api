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
      // Turning the link off is what closes that. It runs before the failure
      // is re-raised, and its own failure is logged inside the seam rather
      // than replacing the error the caller needs to see.
      await this.stripe.deactivatePaymentLink(link.id);
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

// ─── Extension point: deactivating a link when its SKU's price changes ─────
//
// `SkusService.update` already carries the note this pairs with — "a price
// change deactivates this SKU's active Payment Link", finding 9 of
// docs/DESIGN-ATTACK.md — and it is still a note there because the decision
// it needs is not this branch's to take: deactivating is an outbound call to
// Stripe inside a manager's request, and what that request answers when
// Stripe does not respond is undecided.
//
// What is decided here is that nothing silently rewrites history in the
// meantime. `unitPriceAtCreation` records what the published link charges,
// the view publishes that column rather than the SKU's live price, and the
// settlement handler writes the order from it. So a price edit today leaves
// a link that keeps charging the old amount — visibly, in the row and in the
// response — instead of a link whose price nobody can reconstruct.
//
// `StripeService.deactivatePaymentLink` is the seam that method will call,
// and it already reports rather than raises for exactly that reason.
//
// **The same seam has a second caller waiting, and it is the more urgent
// one.** Nothing deactivates a link when its SKU sells out or its product is
// soft-deleted or switched inactive, so the URL keeps taking money for goods
// that cannot be sent. `PaymentLinkCheckoutService` refuses those sales — the
// order is written FAILED and owes a refund — but refusing after the charge
// is damage control, and every buyer who reaches a stale link is another
// refund to make. The three places that would call it are
// `SkusService.update` when stock reaches zero, `ProductsService.update` when
// `isActive` goes false, and `ProductsService.remove`.
// ──────────────────────────────────────────────────────────────────────────
