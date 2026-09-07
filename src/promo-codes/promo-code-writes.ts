import type { Prisma, PromoCodeRedemption } from '@prisma/client';
import { Problems } from '../common/problem/problem.catalog';
import { ProblemException } from '../common/problem/problem.exception';
import { applyPromoCode, type AppliedPromoCode } from './promo-code-policy';

type RedemptionReference = Pick<PromoCodeRedemption, 'promoCodeId'> | null;

/**
 * Re-checks and holds one finite use in the caller's Serializable checkout
 * transaction. The exact updatedAt and counter preconditions make a
 * concurrent reservation or manager edit lose rather than exceed the cap.
 */
export async function reservePromoCodeUsage(
  tx: Prisma.TransactionClient,
  code: string,
  subtotal: number,
  now: Date,
): Promise<AppliedPromoCode> {
  const promoCode = await tx.promoCode.findUnique({
    where: { liveCode: code },
  });

  if (!promoCode) {
    throw new ProblemException(
      Problems.promoCodeUnavailable,
      'The promo code does not exist.',
    );
  }

  const applied = applyPromoCode(promoCode, subtotal, now);
  const remainingAfterSettledUses = promoCode.usageLimit - promoCode.usageCount;
  const reserved = await tx.promoCode.updateMany({
    where: {
      id: promoCode.id,
      liveCode: code,
      deletedAt: null,
      isActive: true,
      expiresAt: { gt: now },
      updatedAt: promoCode.updatedAt,
      usageCount: promoCode.usageCount,
      usageReserved: { lt: remainingAfterSettledUses },
    },
    data: { usageReserved: { increment: 1 } },
  });

  if (reserved.count === 0) {
    throw new ProblemException(
      Problems.promoCodeUnavailable,
      'The promo code changed or its last use was reserved while checkout was running.',
    );
  }

  return applied;
}

export async function consumePromoCodeReservation(
  tx: Prisma.TransactionClient,
  redemption: RedemptionReference,
): Promise<void> {
  if (!redemption) return;

  const consumed = await tx.promoCode.updateMany({
    where: { id: redemption.promoCodeId, usageReserved: { gt: 0 } },
    data: {
      usageReserved: { decrement: 1 },
      usageCount: { increment: 1 },
    },
  });

  assertCounterMoved(consumed.count, redemption.promoCodeId, 'consume');
}

export async function releasePromoCodeReservation(
  tx: Prisma.TransactionClient,
  redemption: RedemptionReference,
): Promise<void> {
  if (!redemption) return;

  const released = await tx.promoCode.updateMany({
    where: { id: redemption.promoCodeId, usageReserved: { gt: 0 } },
    data: { usageReserved: { decrement: 1 } },
  });

  assertCounterMoved(released.count, redemption.promoCodeId, 'release');
}

function assertCounterMoved(
  count: number,
  promoCodeId: string,
  transition: 'consume' | 'release',
): void {
  if (count !== 1) {
    throw new Error(
      `Could not ${transition} the reserved use for promo code ${promoCodeId}.`,
    );
  }
}
