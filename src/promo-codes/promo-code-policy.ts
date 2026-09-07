import { DiscountType, type PromoCode } from '@prisma/client';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';

/** Stripe's minimum for the store's minor-unit currencies. */
export const MINIMUM_CHARGE_AMOUNT = 50;

export interface AppliedPromoCode {
  promoCodeId: string;
  code: string;
  discountAmount: number;
  total: number;
}

/**
 * Applies the contract's money rules without reading or writing state.
 * Percentage arithmetic stays integer-only and rounds ties upward.
 */
export function applyPromoCode(
  promoCode: PromoCode,
  subtotal: number,
  now: Date,
): AppliedPromoCode {
  if (
    promoCode.deletedAt !== null ||
    !promoCode.isActive ||
    promoCode.expiresAt <= now ||
    promoCode.usageCount + promoCode.usageReserved >= promoCode.usageLimit
  ) {
    throw new ProblemException(
      Problems.promoCodeUnavailable,
      'The promo code is inactive, expired or has no uses available.',
    );
  }

  if (
    promoCode.minimumPurchaseAmount !== null &&
    subtotal < promoCode.minimumPurchaseAmount
  ) {
    throw new ProblemException(
      Problems.promoMinimumNotMet,
      `The cart subtotal must be at least ${promoCode.minimumPurchaseAmount} cents for this promo code.`,
    );
  }

  const discountAmount =
    promoCode.type === DiscountType.PERCENTAGE
      ? Math.floor((subtotal * promoCode.discountValue + 50) / 100)
      : promoCode.discountValue;
  const total = subtotal - discountAmount;

  if (total < MINIMUM_CHARGE_AMOUNT) {
    throw new ProblemException(
      Problems.promoTotalTooLow,
      `The discounted total must be at least ${MINIMUM_CHARGE_AMOUNT} cents.`,
    );
  }

  return {
    promoCodeId: promoCode.id,
    code: promoCode.code,
    discountAmount,
    total,
  };
}
