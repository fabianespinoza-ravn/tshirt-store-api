import { Injectable } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { loadOrThrow } from '../../common/load-or-throw';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GUEST_ORDER_SELECT,
  toGuestOrder,
  type GuestOrderView,
} from './guest-orders.views';

@Injectable()
export class GuestOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The one read a buyer with no account can perform.
   *
   * **The `where` has two clauses and both are load-bearing.** The id is the
   * obvious one. The second — that the order carries a `PAYMENT_LINK`
   * payment — is what keeps this route from becoming an unauthenticated
   * back door onto every order in the store. Without it, a public route
   * taking an order id would read a signed-in client's cart checkout too,
   * and `GET /orders/{orderId}`'s CASL scope, the whole thing that keeps one
   * client out of another's rows, could be walked around by asking here
   * instead.
   *
   * So the rule is narrow and stated positively: an order is reachable
   * without a token only if it was **paid through a link**. Everything a
   * signed-in client placed through `POST /orders` stays behind
   * `GET /orders/{orderId}`, because checkout writes
   * `PaymentMethod.PAYMENT_INTENT` and nothing else in the codebase writes
   * `PAYMENT_LINK`.
   *
   * "Paid by link" is not the same as "placed by someone with no account",
   * and the difference is worth naming rather than glossing. The settlement
   * handler attaches a link purchase to an existing account when the Stripe
   * email matches one, so a link order belonging to a registered client is
   * readable here by id. That is the matrix's declared design — the URL is
   * the credential, not the session — and it is why the view below is sized
   * to what a leaked URL may cost rather than to what its holder is assumed
   * to be.
   *
   * An order that fails either clause is a 404, never a 403, for the reason
   * the matrix gives for `getOrder`: a distinguishable refusal turns the
   * route into an oracle for which identifiers exist. Here that matters more
   * than anywhere else, because there is no token to rate-limit by and the
   * id is the only credential.
   *
   * ─── What the id being the credential actually costs ───────────────────
   *
   * Worth stating rather than assuming, because it is the premise of the
   * whole route. Ids in this API are UUIDv7 (`common/ids.ts`), which is a
   * millisecond timestamp followed by 74 random bits. Guessing one is not
   * feasible. Ordering, however, is not secret: two ids reveal which order
   * came first, and an id reveals roughly when its order was placed. Neither
   * helps an attacker find an order they do not already hold.
   *
   * The real exposure of a URL-as-credential is that it leaks the way URLs
   * leak — a referrer header, a shared screenshot, a browser history on a
   * borrowed laptop — and it never expires. That is the reason the view is
   * as thin as it is: the response is sized to what a leak may cost, rather
   * than the route being trusted to keep it.
   * ───────────────────────────────────────────────────────────────────────
   */
  async getOne(orderId: string): Promise<GuestOrderView> {
    return toGuestOrder(
      await loadOrThrow(
        () =>
          this.prisma.order.findFirst({
            where: {
              id: orderId,
              payments: { some: { method: PaymentMethod.PAYMENT_LINK } },
            },
            select: GUEST_ORDER_SELECT,
          }),
        'Order does not exist.',
      ),
    );
  }
}
