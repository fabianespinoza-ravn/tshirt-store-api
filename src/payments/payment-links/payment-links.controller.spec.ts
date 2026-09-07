import { HttpStatus } from '@nestjs/common';
import { CHECK_POLICIES_KEY } from '../../auth/casl/check-policies.decorator';
import { newId } from '../../common/ids';
import { PaymentLinksController } from './payment-links.controller';
import type { PaymentLinksService } from './payment-links.service';
import type { PaymentLinkView } from './payment-links.views';

/**
 * The controller takes a hand-built double rather than the `buildService`
 * harness, the way `cart/cart.controller.spec.ts` does: there is no Prisma
 * and no Stripe on this side of the boundary, only a service mock, an
 * Express response reduced to `status`, and the DTO.
 *
 * `PaymentLinksController.createPaymentLink` is the only handler, and the
 * cases below are the whole of its contract — delegation, and the 201/200
 * split the matrix declares for `createPaymentLink`.
 */
const linkView: PaymentLinkView = {
  id: newId(),
  skuId: newId(),
  stripePaymentLinkId: 'plink-1',
  url: 'https://pay.stripe.test/plink-1',
  unitPrice: 2599,
  isActive: true,
  createdAt: '2026-08-28T12:00:00.000Z',
};

describe('PaymentLinksController', () => {
  const service = { create: jest.fn() };
  const controller = new PaymentLinksController(
    service as unknown as PaymentLinksService,
  );

  // Express reduced to the one method the handler touches, as
  // `testing/http.ts` does for the filter.
  const aResponse = () => ({ status: jest.fn() });

  beforeEach(() => {
    jest.clearAllMocks();
    service.create.mockResolvedValue({ link: linkView, created: true });
  });

  it('delegates the SKU id from the DTO to the service', async () => {
    const dto = { skuId: linkView.skuId };

    await controller.createPaymentLink(dto, aResponse() as never);

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it('sets 201 when the service reports it created the link', async () => {
    const response = aResponse();

    await controller.createPaymentLink(
      { skuId: linkView.skuId },
      response as never,
    );

    expect(response.status).toHaveBeenCalledWith(HttpStatus.CREATED);
    expect(response.status).toHaveBeenCalledTimes(1);
  });

  it('sets 200 when the SKU already had an active link', async () => {
    service.create.mockResolvedValue({ link: linkView, created: false });
    const response = aResponse();

    await controller.createPaymentLink(
      { skuId: linkView.skuId },
      response as never,
    );

    expect(response.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(response.status).toHaveBeenCalledTimes(1);
  });

  it('returns the link view as the body in both cases', async () => {
    for (const created of [true, false]) {
      service.create.mockResolvedValue({ link: linkView, created });

      // `toBe`: the handler sets a status and returns what the service built,
      // and nothing in between may rebuild it.
      await expect(
        controller.createPaymentLink(
          { skuId: linkView.skuId },
          aResponse() as never,
        ),
      ).resolves.toBe(linkView);
    }
  });

  // Named here rather than left to the ability spec, because it is this
  // route's contract rather than the ability's: `PaymentLink` is a declared
  // CASL subject carrying no rule, so `PoliciesGuard` denies every caller —
  // a MANAGER included — until the rule named in the controller's extension
  // point is written.
  it('requires create on PaymentLink, which no ability rule grants yet, so the route answers 403', () => {
    expect(
      Reflect.getMetadata(
        CHECK_POLICIES_KEY,
        PaymentLinksController.prototype.createPaymentLink,
      ),
    ).toEqual([{ action: 'create', subject: 'PaymentLink' }]);
  });
});
