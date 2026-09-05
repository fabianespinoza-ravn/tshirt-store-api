import {
  Body,
  Controller,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CheckPolicies } from '../../auth/casl/check-policies.decorator';
import { PoliciesGuard } from '../../auth/guards/policies.guard';
import { Problems } from '../../common/problem/problem.catalog';
import { ApiProblems } from '../../common/swagger';
import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { PaymentLinksService } from './payment-links.service';
import type { PaymentLinkView } from './payment-links.views';

@ApiTags('Payment links')
@ApiBearerAuth('bearerAuth')
@UseGuards(PoliciesGuard)
@Controller('payment-links')
export class PaymentLinksController {
  constructor(private readonly links: PaymentLinksService) {}

  // ─── Extension point: the MANAGER rule for PaymentLink ──────────────────
  //
  // `PaymentLink` is already a declared subject in
  // `auth/casl/app-ability.factory.ts` and carries no rule, so this route
  // answers **403 to everyone, a manager included**, until one is written.
  // That is `PoliciesGuard` doing its job — a protected route the ability
  // grants nothing for is denied — and not a bug in this module.
  //
  // The rule the matrix asks for, spelled out:
  //
  //   MANAGER · create · PaymentLink
  //
  // It comes from the `createPaymentLink` row of the "Payment links,
  // webhooks and promotions" table in docs/AUTHORIZATION-MATRIX.md: MANAGER,
  // with 401 and 403 declared and no other role named.
  //
  // It carries **no condition**, and that is worth stating rather than
  // leaving to be inferred. A payment link belongs to a SKU and not to a
  // person, so there is no ownership column to scope by; every manager
  // reaches every link. That also means this is one of the rules where a
  // dropped condition could not be a leak — there is nothing to drop — which
  // is the opposite of the cart and order rules the same file warns about.
  //
  // Writing the rule is the student's, per CLAUDE.md. What is written here
  // is the requirement it has to satisfy, and the route that proves it: with
  // no rule the response is 403, with the rule it is 201.
  // ────────────────────────────────────────────────────────────────────────
  @CheckPolicies({ action: 'create', subject: 'PaymentLink' })
  @ApiOperation({ summary: 'Create a Stripe Payment Link for one SKU' })
  @ApiResponse({ status: 201, description: 'The link was published' })
  @ApiResponse({
    status: 200,
    description: 'The SKU already had an active link, returned unchanged',
  })
  @ApiProblems(
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.internalError,
    // Every route in this API reads Postgres, and this one also calls
    // Stripe: a busy or unreachable Stripe is a 503 here, never Stripe's own
    // status passed through. See
    // `common/problem/translators/stripe.translator.ts`.
    Problems.serviceUnavailable,
  )
  @Post()
  async createPaymentLink(
    @Body() dto: CreatePaymentLinkDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaymentLinkView> {
    const { link, created } = await this.links.create(dto);

    // The matrix declares both 200 and 201 for this operation and no static
    // @HttpCode can express the difference. This sets a success status and
    // nothing else: the body is still what the handler returns, and an error
    // is still shaped only by ProblemDetailsFilter.
    // eslint-disable-next-line no-restricted-syntax -- success status, not an error body
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return link;
  }
}
