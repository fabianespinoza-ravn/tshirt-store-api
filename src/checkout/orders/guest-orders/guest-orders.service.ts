import { Injectable } from '@nestjs/common';
import { PaymentMethod, UserState } from '@prisma/client';
import { loadOrThrow } from '@shared/common/load-or-throw';
import { PrismaService } from '@platform/prisma/prisma.service';
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
   * The order id is the credential — no session, no token — so the `where`
   * also requires a `PAYMENT_LINK` payment, and any miss (wrong id, or a
   * `PAYMENT_INTENT` order) answers 404, never 403, to avoid becoming an
   * identifier oracle. See docs/adr/0002-guest-order-url-as-credential.md
   * for why the id is trusted as a credential and why the view stays thin.
   */
  async getOne(orderId: string): Promise<GuestOrderView> {
    return toGuestOrder(
      await loadOrThrow(
        () =>
          this.prisma.order.findFirst({
            where: {
              id: orderId,
              // Two clauses, and each closes a different door.
              //
              // The payment method keeps this public route inside the flow
              // it was written for. Without it, an order id would read a
              // signed-in client's checkout and walk around the CASL scope
              // on `GET /orders/{orderId}`.
              //
              // The owner's state is what makes the URL stop working. A link
              // buyer owns their order through a `GUEST` row; when they
              // register and verify that address, `AuthService` moves the
              // order onto the real account and the guest row is
              // soft-deleted. From that moment the order is theirs to read
              // signed in, and a URL that once reached it must not still.
              // GUEST is never re-entered, so a link cannot be revived.
              payments: { some: { method: PaymentMethod.PAYMENT_LINK } },
              user: { state: UserState.GUEST, deletedAt: null },
            },
            select: GUEST_ORDER_SELECT,
          }),
        'Order does not exist.',
      ),
    );
  }
}
