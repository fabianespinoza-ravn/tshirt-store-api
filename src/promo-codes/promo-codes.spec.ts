import { CartStatus, DiscountType, UserRole } from '@prisma/client';
import { CHECK_POLICIES_KEY } from '../auth/casl/check-policies.decorator';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { buildService, type ServiceHarness } from '../testing/build-service';
import {
  aCart,
  aCartItem,
  anOrder,
  aProduct,
  aPromoCode,
  aSku,
} from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import type {
  CreatePromoCodeDto,
  UpdatePromoCodeDto,
} from './dto/promo-codes.dto';
import { applyPromoCode } from './promo-code-policy';
import {
  consumePromoCodeReservation,
  releasePromoCodeReservation,
  reservePromoCodeUsage,
} from './promo-code-writes';
import { PromoCodesController } from './promo-codes.controller';
import { PromoCodesService } from './promo-codes.service';
import { toPromoCodeView } from './promo-codes.views';
import { toOrder } from '../orders/orders.views';

/* Jest's asymmetric matchers are typed as `any`; they are only partial
 * checks of Prisma calls and are never passed to production code. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const client: AuthenticatedUser = {
  id: 'client-1',
  email: 'client@example.test',
  role: UserRole.CLIENT,
};

describe('promo-code policy', () => {
  const now = new Date('2026-09-07T12:00:00.000Z');

  function thrownBy(run: () => unknown): ProblemException {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemException);
      return error as ProblemException;
    }

    throw new Error('Expected the promo-code policy to reject the input.');
  }

  it('rounds percentage discounts to the nearest cent with ties upward', () => {
    const result = applyPromoCode(aPromoCode({ discountValue: 5 }), 1050, now);

    expect(result.discountAmount).toBe(53);
    expect(result.total).toBe(997);
  });

  it('subtracts fixed discounts as an integer number of cents', () => {
    const result = applyPromoCode(
      aPromoCode({ type: DiscountType.FIXED_AMOUNT, discountValue: 275 }),
      1000,
      now,
    );

    expect(result).toMatchObject({ discountAmount: 275, total: 725 });
  });

  it('compares minimum purchase amount with the server-priced subtotal', () => {
    expect(
      thrownBy(() =>
        applyPromoCode(aPromoCode({ minimumPurchaseAmount: 1001 }), 1000, now),
      ),
    ).toMatchObject({
      kind: Problems.promoMinimumNotMet,
      detail: expect.stringContaining('at least 1001 cents'),
    });
  });

  it('rejects a discounted total below the 50-cent charge minimum', () => {
    expect(
      thrownBy(() =>
        applyPromoCode(
          aPromoCode({ type: DiscountType.FIXED_AMOUNT, discountValue: 951 }),
          1000,
          now,
        ),
      ),
    ).toMatchObject({
      kind: Problems.promoTotalTooLow,
      detail: expect.stringContaining('at least 50 cents'),
    });
  });

  it.each([
    ['inactive', aPromoCode({ isActive: false })],
    ['soft-deleted', aPromoCode({ deletedAt: now, liveCode: null })],
    ['expired', aPromoCode({ expiresAt: now })],
    [
      'exhausted',
      aPromoCode({ usageLimit: 2, usageCount: 1, usageReserved: 1 }),
    ],
  ])('rejects a promo code that is %s', (_state, promoCode) => {
    expect(thrownBy(() => applyPromoCode(promoCode, 1000, now))).toMatchObject({
      kind: Problems.promoCodeUnavailable,
    });
  });

  it('returns the immutable campaign identity with the calculation', () => {
    const promoCode = aPromoCode({ id: 'promo-1', code: 'WELCOME' });

    expect(applyPromoCode(promoCode, 1000, now)).toEqual({
      promoCodeId: 'promo-1',
      code: 'WELCOME',
      discountAmount: 100,
      total: 900,
    });
  });
});

describe('promo-code reservation writes', () => {
  let h: ServiceHarness<PromoCodesService>;
  const now = new Date('2026-09-07T12:00:00.000Z');

  beforeEach(async () => {
    h = await buildService(PromoCodesService);
    resetPrismaMock(h.prisma);
  });

  it('reserves a use with every campaign value it evaluated as a precondition', async () => {
    const promoCode = aPromoCode({
      id: 'promo-1',
      code: 'SAVE10',
      usageLimit: 5,
      usageCount: 2,
      usageReserved: 1,
    });
    h.prisma.promoCode.findUnique.mockResolvedValue(promoCode);
    h.prisma.promoCode.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      reservePromoCodeUsage(h.prisma, promoCode.code, 1000, now),
    ).resolves.toMatchObject({ discountAmount: 100, total: 900 });
    expect(h.prisma.promoCode.findUnique).toHaveBeenCalledWith({
      where: { liveCode: promoCode.code },
    });
    expect(h.prisma.promoCode.updateMany).toHaveBeenCalledWith({
      where: {
        id: promoCode.id,
        liveCode: promoCode.code,
        deletedAt: null,
        isActive: true,
        expiresAt: { gt: now },
        updatedAt: promoCode.updatedAt,
        usageCount: 2,
        usageReserved: { lt: 3 },
      },
      data: { usageReserved: { increment: 1 } },
    });
  });

  it('rejects a missing code before any counter write', async () => {
    h.prisma.promoCode.findUnique.mockResolvedValue(null);

    await expect(
      reservePromoCodeUsage(h.prisma, 'MISSING', 1000, now),
    ).rejects.toMatchObject({ kind: Problems.promoCodeUnavailable });
    expect(h.prisma.promoCode.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a reservation that lost the last use or a manager edit', async () => {
    h.prisma.promoCode.findUnique.mockResolvedValue(aPromoCode());
    h.prisma.promoCode.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      reservePromoCodeUsage(h.prisma, 'SAVE10', 1000, now),
    ).rejects.toMatchObject({ kind: Problems.promoCodeUnavailable });
  });

  it('converts a reserved use into a settled use when payment succeeds', async () => {
    h.prisma.promoCode.updateMany.mockResolvedValue({ count: 1 });

    await consumePromoCodeReservation(h.prisma, { promoCodeId: 'promo-1' });

    expect(h.prisma.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'promo-1', usageReserved: { gt: 0 } },
      data: {
        usageReserved: { decrement: 1 },
        usageCount: { increment: 1 },
      },
    });
  });

  it('releases a reserved use when a pending order ends', async () => {
    h.prisma.promoCode.updateMany.mockResolvedValue({ count: 1 });

    await releasePromoCodeReservation(h.prisma, { promoCodeId: 'promo-1' });

    expect(h.prisma.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'promo-1', usageReserved: { gt: 0 } },
      data: { usageReserved: { decrement: 1 } },
    });
  });

  it.each([
    ['consume', consumePromoCodeReservation],
    ['release', releasePromoCodeReservation],
  ] as const)(
    'fails loudly when it cannot %s the held use',
    async (_name, write) => {
      h.prisma.promoCode.updateMany.mockResolvedValue({ count: 0 });

      await expect(write(h.prisma, { promoCodeId: 'promo-1' })).rejects.toThrow(
        'promo-1',
      );
    },
  );

  it('does not touch promo counters for an order without a redemption', async () => {
    await consumePromoCodeReservation(h.prisma, null);
    await releasePromoCodeReservation(h.prisma, null);

    expect(h.prisma.promoCode.updateMany).not.toHaveBeenCalled();
  });
});

describe('PromoCodesService', () => {
  let h: ServiceHarness<PromoCodesService>;

  beforeEach(async () => {
    h = await buildService(PromoCodesService);
    resetPrismaMock(h.prisma);
  });

  function activeCart(
    quantity = 2,
    overrides: { stock?: number; reserved?: number } = {},
  ) {
    const product = aProduct({ name: 'Server-priced tee' });
    const sku = {
      ...aSku(product.id, {
        price: 500,
        stock: overrides.stock ?? 10,
        reserved: overrides.reserved ?? 0,
      }),
      product,
    };

    return {
      ...aCart(client.id),
      items: [{ ...aCartItem('cart-1', sku.id, { quantity }), sku }],
    };
  }

  it('lists non-deleted campaigns, including inactive and expired rows', async () => {
    const rows = [
      aPromoCode({ isActive: false }),
      aPromoCode({ code: 'OLD', expiresAt: new Date('2026-01-01') }),
    ];
    h.prisma.promoCode.findMany.mockResolvedValue(rows);
    h.prisma.promoCode.count.mockResolvedValue(2);

    const result = await h.service.list({ limit: 10, offset: 20 });

    expect(h.prisma.promoCode.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { code: 'asc' },
      skip: 20,
      take: 10,
    });
    expect(h.prisma.promoCode.count).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
    expect(result.meta).toEqual({ limit: 10, offset: 20, total: 2 });
    expect(result.data).toHaveLength(2);
  });

  it('creates a live campaign and exposes its available uses', async () => {
    const expiresAt = '2027-12-31T23:59:59.000Z';
    const dto: CreatePromoCodeDto = {
      code: 'WELCOME',
      type: DiscountType.PERCENTAGE,
      discountValue: 15,
      expiresAt,
      usageLimit: 20,
      minimumPurchaseAmount: 1000,
    };
    const row = aPromoCode({
      ...dto,
      expiresAt: new Date(expiresAt),
      usageCount: 3,
      usageReserved: 2,
    });
    h.prisma.promoCode.create.mockResolvedValue(row);

    const result = await h.service.create(dto);

    expect(h.prisma.promoCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code: 'WELCOME',
        liveCode: 'WELCOME',
        type: DiscountType.PERCENTAGE,
        discountValue: 15,
        minimumPurchaseAmount: 1000,
        usageLimit: 20,
        expiresAt: new Date(expiresAt),
      }),
    });
    expect(result.usageAvailable).toBe(15);
  });

  it.each([
    [DiscountType.PERCENTAGE, 0],
    [DiscountType.PERCENTAGE, 101],
    [DiscountType.FIXED_AMOUNT, 0],
  ])('rejects invalid %s discount value %d', async (type, discountValue) => {
    await expect(
      h.service.create({
        code: 'BAD',
        type,
        discountValue,
        expiresAt: '2027-12-31T23:59:59.000Z',
        usageLimit: 1,
      }),
    ).rejects.toMatchObject({ kind: Problems.validation });
    expect(h.prisma.promoCode.create).not.toHaveBeenCalled();
  });

  it.each(['not-a-date', '2020-01-01T00:00:00.000Z'])(
    'rejects expiry %s because it is not a future instant',
    async (expiresAt) => {
      await expect(
        h.service.create({
          code: 'BAD-DATE',
          type: DiscountType.FIXED_AMOUNT,
          discountValue: 100,
          expiresAt,
          usageLimit: 1,
        }),
      ).rejects.toMatchObject({ kind: Problems.validation });
    },
  );

  it('updates mutable fields in a serializable transaction without rewriting code or type', async () => {
    const current = aPromoCode({
      id: 'promo-1',
      code: 'IMMUTABLE',
      type: DiscountType.FIXED_AMOUNT,
    });
    const dto: UpdatePromoCodeDto = {
      discountValue: 250,
      expiresAt: '2028-01-01T00:00:00.000Z',
      usageLimit: 50,
      minimumPurchaseAmount: null,
      isActive: false,
    };
    h.prisma.promoCode.findFirst.mockResolvedValue(current);
    h.prisma.promoCode.update.mockResolvedValue(
      aPromoCode({ ...current, ...dto, expiresAt: new Date(dto.expiresAt!) }),
    );

    await h.service.update(current.id, dto);

    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(h.prisma.promoCode.update).toHaveBeenCalledWith({
      where: { id: current.id },
      data: {
        discountValue: 250,
        expiresAt: new Date(dto.expiresAt!),
        usageLimit: 50,
        minimumPurchaseAmount: null,
        isActive: false,
      },
    });
  });

  it('rejects a usage limit below settled plus reserved uses', async () => {
    h.prisma.promoCode.findFirst.mockResolvedValue(
      aPromoCode({ usageCount: 3, usageReserved: 2 }),
    );

    await expect(
      h.service.update('promo-1', { usageLimit: 4 }),
    ).rejects.toMatchObject({ kind: Problems.conflict });
    expect(h.prisma.promoCode.update).not.toHaveBeenCalled();
  });

  it('rejects an update with no mutable fields', async () => {
    await expect(h.service.update('promo-1', {})).rejects.toMatchObject({
      kind: Problems.validation,
    });
    expect(h.prisma.promoCode.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 semantics for a deleted or missing campaign update', async () => {
    h.prisma.promoCode.findFirst.mockResolvedValue(null);

    await expect(
      h.service.update('promo-1', { isActive: false }),
    ).rejects.toMatchObject({ kind: Problems.notFound });
    expect(h.prisma.promoCode.findFirst).toHaveBeenCalledWith({
      where: { id: 'promo-1', deletedAt: null },
    });
  });

  it('validates the active cart at server prices without reserving anything', async () => {
    h.prisma.cart.findFirst.mockResolvedValue(activeCart());
    h.prisma.promoCode.findUnique.mockResolvedValue(
      aPromoCode({ code: 'SAVE10' }),
    );

    await expect(
      h.service.validate(client, { promoCode: 'SAVE10' }),
    ).resolves.toEqual({
      promoCode: 'SAVE10',
      discountAmount: 100,
      total: 900,
    });
    expect(h.prisma.cart.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: client.id, status: CartStatus.ACTIVE },
      }),
    );
    expect(h.prisma.promoCode.findUnique).toHaveBeenCalledWith({
      where: { liveCode: 'SAVE10' },
    });
    expect(h.prisma.promoCode.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.sku.update).not.toHaveBeenCalled();
  });

  it('rejects an empty active cart', async () => {
    const cart = activeCart();
    cart.items = [];
    h.prisma.cart.findFirst.mockResolvedValue(cart);

    await expect(
      h.service.validate(client, { promoCode: 'SAVE10' }),
    ).rejects.toMatchObject({ kind: Problems.cartNotCheckoutable });
  });

  it('rejects a code that does not exist', async () => {
    h.prisma.cart.findFirst.mockResolvedValue(activeCart());
    h.prisma.promoCode.findUnique.mockResolvedValue(null);

    await expect(
      h.service.validate(client, { promoCode: 'MISSING' }),
    ).rejects.toMatchObject({ kind: Problems.promoCodeUnavailable });
  });

  it('rechecks current cart availability before validating a code', async () => {
    h.prisma.cart.findFirst.mockResolvedValue(
      activeCart(2, { stock: 2, reserved: 1 }),
    );

    await expect(
      h.service.validate(client, { promoCode: 'SAVE10' }),
    ).rejects.toMatchObject({ kind: Problems.stockUnavailable });
    expect(h.prisma.promoCode.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a cart line whose product is no longer for sale', async () => {
    const cart = activeCart();
    cart.items[0].sku.product.isActive = false;
    h.prisma.cart.findFirst.mockResolvedValue(cart);

    await expect(
      h.service.validate(client, { promoCode: 'SAVE10' }),
    ).rejects.toMatchObject({ kind: Problems.itemWithdrawn });
  });
});

describe('PromoCodesController', () => {
  const promoCode = toPromoCodeView(aPromoCode());
  const page = { data: [promoCode], meta: { limit: 20, offset: 0, total: 1 } };
  const validation = { promoCode: 'SAVE10', discountAmount: 100, total: 900 };
  const service = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    validate: jest.fn(),
  };
  const controller = new PromoCodesController(
    service as unknown as PromoCodesService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('passes list pagination through unchanged', async () => {
    service.list.mockResolvedValue(page);
    const query = { limit: 20, offset: 40 };

    await expect(controller.list(query)).resolves.toBe(page);
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('passes create fields through unchanged', async () => {
    service.create.mockResolvedValue(promoCode);
    const dto = {
      code: 'SAVE10',
      type: DiscountType.PERCENTAGE,
      discountValue: 10,
      expiresAt: '2027-12-31T23:59:59.000Z',
      usageLimit: 100,
    };

    await expect(controller.create(dto)).resolves.toBe(promoCode);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('validates for the authenticated client rather than a body identity', async () => {
    service.validate.mockResolvedValue(validation);
    const dto = { promoCode: 'SAVE10' };

    await expect(controller.validate(client, dto)).resolves.toBe(validation);
    expect(service.validate).toHaveBeenCalledWith(client, dto);
  });

  it('passes the path id and mutable update fields to the service', async () => {
    service.update.mockResolvedValue(promoCode);
    const dto = { isActive: false };

    await expect(controller.update('promo-1', dto)).resolves.toBe(promoCode);
    expect(service.update).toHaveBeenCalledWith('promo-1', dto);
  });

  it.each([
    ['list', 'read', 'PromoCode'],
    ['create', 'create', 'PromoCode'],
    ['validate', 'validate', 'PromoCode'],
    ['update', 'update', 'PromoCode'],
  ])('declares %s as %s on %s', (method, action, subject) => {
    const handler = Object.getOwnPropertyDescriptor(
      PromoCodesController.prototype,
      method,
    )?.value as object;

    expect(Reflect.getMetadata(CHECK_POLICIES_KEY, handler)).toEqual([
      { action, subject },
    ]);
  });
});

describe('promo-code abilities', () => {
  const factory = new AppAbilityFactory();

  it('allows managers to create, list and update promo codes', () => {
    const ability = factory.createForUser({
      id: 'manager-1',
      email: 'manager@example.test',
      role: UserRole.MANAGER,
    });

    expect(ability.can('create', 'PromoCode')).toBe(true);
    expect(ability.can('read', 'PromoCode')).toBe(true);
    expect(ability.can('update', 'PromoCode')).toBe(true);
    expect(ability.can('validate', 'PromoCode')).toBe(false);
  });

  it('allows clients to validate but not manage promo codes', () => {
    const ability = factory.createForUser(client);

    expect(ability.can('validate', 'PromoCode')).toBe(true);
    expect(ability.can('read', 'PromoCode')).toBe(false);
    expect(ability.can('create', 'PromoCode')).toBe(false);
    expect(ability.can('update', 'PromoCode')).toBe(false);
  });
});

describe('promo-code order snapshot', () => {
  it('publishes the code captured at checkout instead of joining the campaign', () => {
    const order = {
      ...anOrder(client.id, { orderDiscountAmount: 100, total: 900 }),
      items: [],
      payments: [],
      redemption: { promoCodeId: 'promo-1', codeSnapshot: 'WELCOME' },
    };

    expect(toOrder(order)).toMatchObject({
      discount: 100,
      total: 900,
      promoCode: 'WELCOME',
    });
  });
});
