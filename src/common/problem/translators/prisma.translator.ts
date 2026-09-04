import { Prisma } from '@prisma/client';
import { Problems } from '../problem.catalog';
import type {
  ProblemTranslation,
  ProblemTranslator,
} from './problem-translator';

/**
 * Codes that say the database could not be reached, was overloaded, or went
 * away mid-query. They are context-free: they mean the same thing wherever
 * they are thrown and say nothing about the request that ran into them, so
 * mapping them globally is safe.
 *
 * They are a 503 and not a 500 because the distinction is the only thing a
 * client can act on. A 500 says "this request will never work"; a 503 says
 * "the request was fine, come back". `docs/ARQUITECTURA.md` already treats
 * pool saturation as something to observe rather than a bug, and P2024 is
 * exactly that seen from the request's side.
 */
const UNAVAILABLE = new Map<string, string>([
  ['P1001', 'The database could not be reached.'],
  ['P1002', 'The database did not answer in time.'],
  ['P1008', 'The database operation timed out.'],
  ['P1017', 'The database closed the connection.'],
  ['P2024', 'The database connection pool is saturated.'],
]);

/**
 * A write that lost a race against a concurrent one: a deadlock, or a
 * serialization failure inside an interactive transaction. Nothing is wrong
 * with the request, and repeating it is the documented remedy, so it is a
 * 409 rather than a 500. Week 4's order flow reserves stock inside a
 * transaction, which is where this stops being theoretical.
 */
const WRITE_CONFLICT = 'P2034';

/**
 * P2002 by constraint, never in bulk.
 *
 * The key is `Model:field,field` because that is what Prisma actually hands
 * over — measured against Postgres with the client in `package.json` rather
 * than remembered: `meta` arrives as `{"modelName":"Category","target":["name"]}`,
 * a string array of *Prisma field names*. The index name declared in
 * `schema.prisma` (`uq_categories_name`) never appears, so a map keyed on it
 * would silently match nothing. The field order follows the `@@unique`
 * declaration.
 *
 * This is an allowlist and not a denylist, and the difference matters more
 * than it looks. Translating every P2002 into a 409 would turn
 * `uq_users_email_live` into an oracle for which addresses are registered:
 * sign-up answers 409 for a taken address and something else otherwise, and
 * the contract says in as many words that this route must not be usable to
 * find out which emails exist. The token-hash constraints are left out for
 * the same reason in the other direction — a collision there is our bug or a
 * rotation race, and a client has no business being told a row about someone
 * else's token conflicted.
 *
 * So: an entry here is a deliberate statement that this particular collision
 * is the caller's business. Anything absent stays the loud 500 it is today,
 * which is the safe direction — a new unique index has to be added here on
 * purpose rather than inherit a 409 nobody thought about.
 */
const UNIQUE_CONFLICTS = new Map<string, string>([
  ['Category:name', 'Another category already uses that name.'],
  [
    'Sku:productId,size,color',
    'That size and colour already exist for this product.',
  ],
  [
    'ProductCategory:productId,categoryId',
    'The product is already assigned to that category.',
  ],
  // The three below are races rather than mistakes: each route reads and
  // then writes, so two requests in flight can both pass the read. The
  // remedy is to repeat the request, which is what a 409 says.
  ['Cart:activeUserId', 'The cart changed while the request was running.'],
  ['CartItem:cartId,skuId', 'The line changed while the request was running.'],
  [
    'ProductLike:userId,productId',
    'The like changed while the request was running.',
  ],
]);

/**
 * `Model:field,field` for a unique violation, or `undefined` when the error
 * does not carry the shape this depends on. Prisma types `meta` as
 * `unknown`, and a version that changed it would otherwise turn every
 * conflict into a crash inside the error path.
 */
function uniqueKey(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;

  const { modelName, target } = meta as {
    modelName?: unknown;
    target?: unknown;
  };

  if (typeof modelName !== 'string' || !Array.isArray(target)) return undefined;

  const fields = target.filter(
    (field): field is string => typeof field === 'string',
  );

  return fields.length > 0 ? `${modelName}:${fields.join(',')}` : undefined;
}

/**
 * Prisma errors that carry a meaning worth serving. Everything else —
 * `PrismaClientValidationError`, P2009, P2021, and the rest of the family
 * that means the query itself is wrong — is deliberately not translated:
 * those are our bugs, they are already a 500, and dressing them up as
 * anything else would hide them.
 *
 * P2025 (no record found on update or delete) is also left alone on
 * purpose. Services here resolve the row first with a scoped `findFirst`
 * and throw their own 404 — `CartService.loadItem` is the pattern — so a
 * P2025 reaching this point means the row vanished between the read and the
 * write, which is a race we have no honest 404 for.
 */
export const translatePrismaError: ProblemTranslator = (
  error: unknown,
): ProblemTranslation | undefined => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError))
    return undefined;

  const unavailable = UNAVAILABLE.get(error.code);
  if (unavailable) {
    return { kind: Problems.serviceUnavailable, detail: unavailable };
  }

  if (error.code === WRITE_CONFLICT) {
    return {
      kind: Problems.conflict,
      detail: 'The request conflicted with a concurrent one. Try again.',
    };
  }

  if (error.code === 'P2002') {
    const key = uniqueKey(error.meta);
    const detail = key === undefined ? undefined : UNIQUE_CONFLICTS.get(key);

    return detail ? { kind: Problems.conflict, detail } : undefined;
  }

  return undefined;
};
