import { Prisma } from '@prisma/client';
import { translateProblem } from './index';

/**
 * Harness only: the assertions are the student's (CLAUDE.md, Tests).
 *
 * The registry itself has one job worth testing — that an error no
 * translator claims comes back as `undefined`, so the filter keeps serving
 * the generic 500 it served before any of this existed. That is the property
 * that makes the layer safe to add: covering too little costs nothing.
 *
 * The `origin` label is the other half. It never reaches the client; it is
 * the only reason a translated 503 is not quieter than the 500 it replaced,
 * so a test that ignores it would let the observability regress silently.
 */
describe('translateProblem', () => {
  const known = (code: string): Prisma.PrismaClientKnownRequestError =>
    new Prisma.PrismaClientKnownRequestError('from the harness', {
      code,
      clientVersion: Prisma.prismaVersion.client,
    });

  const anAwsError = (name: string, httpStatusCode: number): Error => {
    const error = new Error('from the harness');
    error.name = name;
    Object.assign(error, { $metadata: { httpStatusCode } });
    return error;
  };

  it.todo(
    'returns the translation of the first translator that claims the error',
  );
  it.todo('returns undefined when no translator recognises the error');
  it.todo('labels the origin with the error code when there is one');
  it.todo('labels the origin with the error name when there is no code');
  it.todo('never puts the original message in the label');

  void translateProblem;
  void known;
  void anAwsError;
});
