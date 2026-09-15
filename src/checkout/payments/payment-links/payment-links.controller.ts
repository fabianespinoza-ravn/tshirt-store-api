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
import { CheckPolicies } from '@auth/casl/check-policies.decorator';
import { PoliciesGuard } from '@auth/guards/policies.guard';
import { Problems } from '@shared/common/problem/problem.catalog';
import { ApiProblems } from '@shared/common/swagger';
import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { PaymentLinksService } from './payment-links.service';
import type { PaymentLinkView } from './payment-links.views';

@ApiTags('Payment links')
@ApiBearerAuth('bearerAuth')
@UseGuards(PoliciesGuard)
@Controller('payment-links')
export class PaymentLinksController {
  constructor(private readonly links: PaymentLinksService) {}

  // Payment links belong to SKUs rather than users, so the authorization
  // matrix grants MANAGER an unconditional create rule. PoliciesGuard denies
  // every other role, and the route's e2e coverage proves that boundary.
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
