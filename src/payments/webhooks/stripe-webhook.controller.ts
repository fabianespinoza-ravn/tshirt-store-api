import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { Problems } from '../../common/problem/problem.catalog';
import { ApiProblems } from '../../common/swagger';
import { StripeWebhookService } from './stripe-webhook.service';

/** What Stripe reads of the response, which is nothing but its status. */
export interface StripeWebhookAck {
  received: boolean;
}

/**
 * The one route in this API whose caller is not a person.
 *
 * It carries no bearer token and no CASL policy, and neither is missing:
 * `docs/AUTHORIZATION-MATRIX.md` lists `receiveStripeEvent` as authenticated
 * by signature, so the credential is the `Stripe-Signature` header and the
 * verification in the service is the authentication. A JWT here would be a
 * token Stripe has no way to hold.
 *
 * **Extension point — no ability rule belongs here.** Every other row of the
 * matrix reaches `PoliciesGuard`; this one deliberately does not, because
 * there is no subject to scope and no user to scope it to. If a future
 * operator-facing replay route is added — "deliver this event again" — that
 * one is a MANAGER row of the matrix and needs its own rule; this route
 * still would not.
 */
@ApiTags('Payments')
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly webhooks: StripeWebhookService) {}

  /**
   * 200 as soon as the event is verified and written down.
   *
   * Nest answers 201 to a POST by default and the contract declares 200 for
   * this operation, so the code is set by hand. What the status means here
   * is narrow and worth stating: the event was authentic and has been
   * recorded, **not** that the order has moved. Stripe stops retrying on any
   * 2xx, which is why nothing slow or fallible is allowed to run before this
   * returns.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a signed Stripe event' })
  @ApiResponse({ status: 200, description: 'Event verified and recorded' })
  @ApiProblems(
    Problems.validation,
    Problems.internalError,
    Problems.serviceUnavailable,
  )
  @Post('stripe')
  async receiveStripeEvent(
    // The parsed body is useless to this route: the signature covers the
    // bytes Stripe sent, so `request.rawBody` is what gets verified. It is
    // present because `main.ts` boots with `rawBody: true`, and typed as
    // optional because Nest cannot know that at compile time.
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<StripeWebhookAck> {
    await this.webhooks.receive(request.rawBody, signature);

    return { received: true };
  }
}
