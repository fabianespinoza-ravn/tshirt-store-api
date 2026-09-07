import { Injectable } from '@nestjs/common';
import { CartStatus, DiscountType, Prisma } from '@prisma/client';
import { availableOf } from '../catalog/views';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { newId } from '../common/ids';
import { loadOrThrow } from '../common/load-or-throw';
import {
  paginate,
  type Paginated,
  type PaginationQueryDto,
} from '../common/pagination';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreatePromoCodeDto,
  UpdatePromoCodeDto,
  ValidatePromoCodeDto,
} from './dto/promo-codes.dto';
import { applyPromoCode } from './promo-code-policy';
import {
  toPromoCodeView,
  type PromoCodeValidationView,
  type PromoCodeView,
} from './promo-codes.views';

const PROMO_CART_INCLUDE = {
  items: { include: { sku: { include: { product: true } } } },
} satisfies Prisma.CartInclude;

type PromoCart = Prisma.CartGetPayload<{
  include: typeof PROMO_CART_INCLUDE;
}>;

@Injectable()
export class PromoCodesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PaginationQueryDto): Promise<Paginated<PromoCodeView>> {
    const where: Prisma.PromoCodeWhereInput = { deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.promoCode.findMany({
        where,
        orderBy: { code: 'asc' },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.promoCode.count({ where }),
    ]);

    return paginate(rows.map(toPromoCodeView), total, query);
  }

  async create(dto: CreatePromoCodeDto): Promise<PromoCodeView> {
    const expiresAt = this.futureDate(dto.expiresAt);
    this.assertDiscountValue(dto.type, dto.discountValue);

    return toPromoCodeView(
      await this.prisma.promoCode.create({
        data: {
          id: newId(),
          code: dto.code,
          liveCode: dto.code,
          type: dto.type,
          discountValue: dto.discountValue,
          minimumPurchaseAmount: dto.minimumPurchaseAmount ?? null,
          usageLimit: dto.usageLimit,
          expiresAt,
        },
      }),
    );
  }

  async update(
    promoCodeId: string,
    dto: UpdatePromoCodeDto,
  ): Promise<PromoCodeView> {
    this.assertUpdateHasChanges(dto);

    return this.prisma.$transaction(
      async (tx) => {
        const promoCode = await loadOrThrow(
          () =>
            tx.promoCode.findFirst({
              where: { id: promoCodeId, deletedAt: null },
            }),
          'Promo code does not exist.',
        );

        if (dto.discountValue !== undefined) {
          this.assertDiscountValue(promoCode.type, dto.discountValue);
        }

        if (
          dto.usageLimit !== undefined &&
          dto.usageLimit < promoCode.usageCount + promoCode.usageReserved
        ) {
          throw new ProblemException(
            Problems.conflict,
            'The usage limit cannot be lower than settled plus reserved uses.',
          );
        }

        const expiresAt =
          dto.expiresAt === undefined
            ? undefined
            : this.futureDate(dto.expiresAt);

        return toPromoCodeView(
          await tx.promoCode.update({
            where: { id: promoCode.id },
            data: {
              ...(dto.discountValue !== undefined
                ? { discountValue: dto.discountValue }
                : {}),
              ...(expiresAt !== undefined ? { expiresAt } : {}),
              ...(dto.usageLimit !== undefined
                ? { usageLimit: dto.usageLimit }
                : {}),
              ...(dto.minimumPurchaseAmount !== undefined
                ? { minimumPurchaseAmount: dto.minimumPurchaseAmount }
                : {}),
              ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            },
          }),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** Reprices the caller's current cart and holds no stock or promo use. */
  async validate(
    user: AuthenticatedUser,
    dto: ValidatePromoCodeDto,
  ): Promise<PromoCodeValidationView> {
    const cart = await this.prisma.cart.findFirst({
      where: { userId: user.id, status: CartStatus.ACTIVE },
      include: PROMO_CART_INCLUDE,
    });

    if (!cart || cart.items.length === 0) {
      throw new ProblemException(
        Problems.cartNotCheckoutable,
        'The cart is empty.',
      );
    }

    const subtotal = this.subtotalOf(cart);
    const promoCode = await this.prisma.promoCode.findUnique({
      where: { liveCode: dto.promoCode },
    });

    if (!promoCode) {
      throw new ProblemException(
        Problems.promoCodeUnavailable,
        'The promo code does not exist.',
      );
    }

    const applied = applyPromoCode(promoCode, subtotal, new Date());

    return {
      promoCode: applied.code,
      discountAmount: applied.discountAmount,
      total: applied.total,
    };
  }

  private subtotalOf(cart: PromoCart): number {
    let subtotal = 0;

    for (const line of cart.items) {
      if (line.sku.product.deletedAt || !line.sku.product.isActive) {
        throw new ProblemException(
          Problems.itemWithdrawn,
          `${line.sku.product.name} is no longer for sale.`,
        );
      }

      const available = availableOf(line.sku);
      if (line.quantity > available) {
        throw new ProblemException(
          Problems.stockUnavailable,
          `Only ${available} unit(s) of ${line.sku.product.name} are available.`,
        );
      }

      subtotal += line.sku.price * line.quantity;
    }

    return subtotal;
  }

  private futureDate(raw: string): Date {
    const date = new Date(raw);

    if (Number.isNaN(date.getTime()) || date <= new Date()) {
      throw new ProblemException(
        Problems.validation,
        'The promo code expiry must be a valid future instant.',
      );
    }

    return date;
  }

  private assertDiscountValue(type: DiscountType, discountValue: number): void {
    if (
      !Number.isInteger(discountValue) ||
      discountValue < 1 ||
      (type === DiscountType.PERCENTAGE && discountValue > 100)
    ) {
      throw new ProblemException(
        Problems.validation,
        type === DiscountType.PERCENTAGE
          ? 'A percentage discount must be a whole number from 1 to 100.'
          : 'A fixed discount must be a positive integer number of cents.',
      );
    }
  }

  private assertUpdateHasChanges(dto: UpdatePromoCodeDto): void {
    if (
      dto.discountValue === undefined &&
      dto.expiresAt === undefined &&
      dto.usageLimit === undefined &&
      dto.minimumPurchaseAmount === undefined &&
      dto.isActive === undefined
    ) {
      throw new ProblemException(
        Problems.validation,
        'At least one promo code field must be provided.',
      );
    }
  }
}
