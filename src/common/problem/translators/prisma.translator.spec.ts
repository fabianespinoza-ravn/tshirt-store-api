import { Prisma } from '@prisma/client';
import { Problems } from '../problem.catalog';
import { translatePrismaError } from './prisma.translator';

/**
 * Harness only: each case below names one branch of the translator, and the
 * assertions are the student's (CLAUDE.md, Tests).
 *
 * Two of them are worth more than the rest together, and both are about what
 * the translator refuses to do. `uq_users_email_live` must stay untranslated:
 * the moment a unique-email violation becomes a 409, sign-up answers
 * differently for a registered address than for a free one and the route is
 * an oracle for which emails exist. And an unmapped constraint must return
 * `undefined` rather than a generic 409, because the allowlist is the only
 * thing standing between "this collision is the caller's business" and "every
 * unique index in the schema now leaks its meaning".
 *
 * The rest assert a mapping. Assert the returned `kind` — the catalog entry —
 * and not only the status: two entries share 409, and a test that only checks
 * the number would pass with the wrong problem type in the body.
 */
describe('translatePrismaError', () => {
  const known = (
    code: string,
    meta?: Record<string, unknown>,
  ): Prisma.PrismaClientKnownRequestError =>
    new Prisma.PrismaClientKnownRequestError('from the harness', {
      code,
      clientVersion: Prisma.prismaVersion.client,
      meta,
    });

  /** The shape measured against Postgres: field names, not the index name. */
  const uniqueOn = (
    modelName: string,
    ...target: string[]
  ): Prisma.PrismaClientKnownRequestError =>
    known('P2002', { modelName, target });

  describe('the database is unreachable or overloaded', () => {
    it.each([
      ['P1001', 'The database could not be reached.'],
      ['P1002', 'The database did not answer in time.'],
      ['P1008', 'The database operation timed out.'],
      ['P1017', 'The database closed the connection.'],
      ['P2024', 'The database connection pool is saturated.'],
    ])('answers 503 when %s occurs', (code, detail) => {
      expect(translatePrismaError(known(code))).toEqual({
        kind: Problems.serviceUnavailable,
        detail,
      });
    });
  });

  describe('a write that lost a race', () => {
    it('answers 409 for a write conflict or deadlock (P2034)', () => {
      expect(translatePrismaError(known('P2034'))).toMatchObject({
        kind: Problems.conflict,
      });
    });

    it('tells the client to retry rather than reporting a failure', () => {
      expect(translatePrismaError(known('P2034'))?.detail).toContain(
        'Try again',
      );
    });
  });

  describe('a unique violation, by constraint', () => {
    it('translates a duplicate category name into the contract 409', () => {
      expect(translatePrismaError(uniqueOn('Category', 'name'))).toEqual({
        kind: Problems.conflict,
        detail: 'Another category already uses that name.',
      });
    });

    it('translates a duplicate size and colour on a product into 409', () => {
      expect(
        translatePrismaError(uniqueOn('Sku', 'productId', 'size', 'color')),
      ).toEqual({
        kind: Problems.conflict,
        detail: 'That size and colour already exist for this product.',
      });
    });

    it('translates a duplicate product-category assignment into 409', () => {
      expect(
        translatePrismaError(
          uniqueOn('ProductCategory', 'productId', 'categoryId'),
        ),
      ).toEqual({
        kind: Problems.conflict,
        detail: 'The product is already assigned to that category.',
      });
    });

    it('translates the three concurrency constraints into a retryable 409', () => {
      expect(translatePrismaError(uniqueOn('Cart', 'activeUserId'))).toEqual({
        kind: Problems.conflict,
        detail: 'The cart changed while the request was running.',
      });
      expect(
        translatePrismaError(uniqueOn('CartItem', 'cartId', 'skuId')),
      ).toEqual({
        kind: Problems.conflict,
        detail: 'The line changed while the request was running.',
      });
      expect(
        translatePrismaError(uniqueOn('ProductLike', 'userId', 'productId')),
      ).toEqual({
        kind: Problems.conflict,
        detail: 'The like changed while the request was running.',
      });
    });

    it('leaves the live-email constraint untranslated, so sign-up cannot be used to enumerate addresses', () => {
      expect(
        translatePrismaError(uniqueOn('User', 'liveEmail')),
      ).toBeUndefined();
    });

    it('leaves a token-hash collision untranslated', () => {
      expect(
        translatePrismaError(uniqueOn('RefreshToken', 'tokenHash')),
      ).toBeUndefined();
    });

    it('declines a constraint that is not in the allowlist', () => {
      expect(
        translatePrismaError(uniqueOn('ProductImage', 'id', 'productId')),
      ).toBeUndefined();
    });

    it('declines when meta carries no modelName or no target array', () => {
      expect(
        translatePrismaError(known('P2002', { target: ['name'] })),
      ).toBeUndefined();
      expect(
        translatePrismaError(
          known('P2002', { modelName: 'Category', target: 'name' }),
        ),
      ).toBeUndefined();
    });
  });

  describe('what it deliberately does not touch', () => {
    it('declines P2025, which the services answer as their own 404', () => {
      expect(translatePrismaError(known('P2025'))).toBeUndefined();
    });

    it('declines a validation error, which means our query is wrong', () => {
      expect(
        translatePrismaError(
          new Prisma.PrismaClientValidationError('from the harness', {
            clientVersion: Prisma.prismaVersion.client,
          }),
        ),
      ).toBeUndefined();
    });

    it('declines an error that did not come from Prisma', () => {
      expect(
        translatePrismaError(new Error('from the harness')),
      ).toBeUndefined();
    });
  });
});
