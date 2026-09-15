import type { PromoCode } from '@prisma/client';

export interface PromoCodeView {
  id: string;
  code: string;
  type: PromoCode['type'];
  discountValue: number;
  minimumPurchaseAmount: number | null;
  usageLimit: number;
  usageCount: number;
  usageReserved: number;
  usageAvailable: number;
  expiresAt: string;
  isActive: boolean;
}

export interface PromoCodeValidationView {
  promoCode: string;
  discountAmount: number;
  total: number;
}

export function toPromoCodeView(promoCode: PromoCode): PromoCodeView {
  return {
    id: promoCode.id,
    code: promoCode.code,
    type: promoCode.type,
    discountValue: promoCode.discountValue,
    minimumPurchaseAmount: promoCode.minimumPurchaseAmount,
    usageLimit: promoCode.usageLimit,
    usageCount: promoCode.usageCount,
    usageReserved: promoCode.usageReserved,
    usageAvailable:
      promoCode.usageLimit - promoCode.usageCount - promoCode.usageReserved,
    expiresAt: promoCode.expiresAt.toISOString(),
    isActive: promoCode.isActive,
  };
}
