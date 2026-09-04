import { Prisma } from '@prisma/client';
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
    it.todo('answers 503 when the database cannot be reached (P1001)');
    it.todo('answers 503 when the database does not respond in time (P1002)');
    it.todo('answers 503 when the operation times out (P1008)');
    it.todo('answers 503 when the connection is closed mid-query (P1017)');
    it.todo('answers 503 when the connection pool is saturated (P2024)');
  });

  describe('a write that lost a race', () => {
    it.todo('answers 409 for a write conflict or deadlock (P2034)');
    it.todo('tells the client to retry rather than reporting a failure');
  });

  describe('a unique violation, by constraint', () => {
    it.todo('translates a duplicate category name into the contract 409');
    it.todo('translates a duplicate size and colour on a product into 409');
    it.todo('translates a duplicate product-category assignment into 409');
    it.todo(
      'translates the three concurrency constraints into a retryable 409',
    );
    it.todo(
      'leaves the live-email constraint untranslated, so sign-up cannot be used to enumerate addresses',
    );
    it.todo('leaves a token-hash collision untranslated');
    it.todo('declines a constraint that is not in the allowlist');
    it.todo('declines when meta carries no modelName or no target array');
  });

  describe('what it deliberately does not touch', () => {
    it.todo('declines P2025, which the services answer as their own 404');
    it.todo('declines a validation error, which means our query is wrong');
    it.todo('declines an error that did not come from Prisma');
  });

  void translatePrismaError;
  void known;
  void uniqueOn;
});
