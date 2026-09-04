import { Prisma } from '@prisma/client';
import { Problems } from '../problem.catalog';
import { translateProblem } from './index';

/**
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

  it('returns the translation of the first translator that claims the error', () => {
    expect(translateProblem(known('P1001'))).toEqual({
      kind: Problems.serviceUnavailable,
      detail: 'The database could not be reached.',
      origin: 'P1001',
    });
  });

  it('returns undefined when no translator recognises the error', () => {
    expect(translateProblem(new Error('from the harness'))).toBeUndefined();
  });

  it('labels the origin with the error code when there is one', () => {
    const error = known('P2002');
    Object.assign(error, { meta: { modelName: 'Category', target: ['name'] } });

    expect(translateProblem(error)?.origin).toBe('P2002');
  });

  it('labels the origin with the error name when there is no code', () => {
    expect(translateProblem(anAwsError('SlowDown', 503))?.origin).toBe(
      'SlowDown',
    );
  });

  it('never puts the original message in the label', () => {
    const error = known('P1001');
    error.message = 'connect host=db.internal port=5432 user=app';

    expect(translateProblem(error)?.origin).toBe('P1001');
    expect(translateProblem(error)?.origin).not.toContain('db.internal');
  });
});
