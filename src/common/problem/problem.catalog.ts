// RFC 9457 problem catalog: every type and every title must match
// openapi.yaml, and changing one breaks the contract even if the code still
// compiles.
export const PROBLEM_BASE = 'https://api.tshirt-store.example/problems';

export interface ProblemKind {
  readonly type: string;
  readonly title: string;
  readonly status: number;
}

function kind(slug: string, title: string, status: number): ProblemKind {
  return { type: `${PROBLEM_BASE}/${slug}`, title, status };
}

export const Problems = {
  // Shared, declared in components/responses
  validation: kind('validation', 'Validation failed', 400),
  unauthorized: kind('unauthorized', 'Authentication required', 401),
  forbidden: kind('forbidden', 'Operation forbidden', 403),
  emailNotVerified: kind('email-not-verified', 'Email not verified', 403),
  emailVerificationTokenNotFound: kind(
    'email-verification-token-not-found',
    'Email verification token not found',
    404,
  ),
  notFound: kind('not-found', 'Resource not found', 404),
  conflict: kind('conflict', 'Resource conflict', 409),
  payloadTooLarge: kind('payload-too-large', 'File too large', 413),
  unsupportedMediaType: kind(
    'unsupported-media-type',
    'Unsupported media type',
    415,
  ),
  rateLimited: kind('rate-limited', 'Too many requests', 429),
  internalError: kind('internal-error', 'Internal server error', 500),

  // The seven of CheckoutConflict, grouped by the client's remedy and not by
  // the condition that produced them. Only `orderAlreadyPending` carries the
  // `expiresAt` extension.
  cartNotCheckoutable: kind(
    'cart-not-checkoutable',
    'Cart cannot be checked out',
    409,
  ),
  stockUnavailable: kind(
    'stock-unavailable',
    'Not enough units available',
    409,
  ),
  orderAlreadyPending: kind(
    'order-already-pending',
    'A pending order already holds this stock',
    409,
  ),
  promoCodeUnavailable: kind(
    'promo-code-unavailable',
    'Promo code cannot be used',
    409,
  ),
  promoMinimumNotMet: kind(
    'promo-minimum-not-met',
    'Cart is below the promo code minimum',
    409,
  ),
  promoTotalTooLow: kind(
    'promo-total-too-low',
    'Discounted total is below the minimum charge',
    409,
  ),
  itemWithdrawn: kind(
    'item-withdrawn',
    'A cart line is no longer for sale',
    409,
  ),
} as const;

// Default problem for an HttpException nobody classified: a status with no
// entry here comes out as an internal error instead of as a half-built
// document.
const BY_STATUS = new Map<number, ProblemKind>(
  [
    Problems.validation,
    Problems.unauthorized,
    Problems.forbidden,
    Problems.notFound,
    Problems.conflict,
    Problems.payloadTooLarge,
    Problems.unsupportedMediaType,
    Problems.rateLimited,
    Problems.internalError,
  ].map((p) => [p.status, p]),
);

export function problemForStatus(status: number): ProblemKind {
  return BY_STATUS.get(status) ?? Problems.internalError;
}
