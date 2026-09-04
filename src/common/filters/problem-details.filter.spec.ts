import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { anArgumentsHost } from '../../testing/http';
import { Problems } from '../problem/problem.catalog';
import { ProblemException } from '../problem/problem.exception';
import * as translators from '../problem/translators';
import { ProblemDetailsFilter } from './problem-details.filter';

/**
 * Everything asserted here comes from the Week 2 contract: `ProblemDetails`
 * declares the five fields as required, and `components/responses` serves
 * every error as `application/problem+json`.
 */
describe('ProblemDetailsFilter', () => {
  const filter = new ProblemDetailsFilter();

  const catchIt = (error: unknown, url = '/api/v1/resource') => {
    const { host, recorded } = anArgumentsHost({ url });
    filter.catch(error, host);
    return recorded;
  };

  /**
   * A dependency failure shaped the way the AWS SDK shapes one: the upstream
   * code in `name`, the upstream status in `$metadata`. This is what reaches
   * the filter from `StorageService` when the bucket answers badly, and the
   * kind of value a translator will claim.
   *
   * The default is a retryable upstream status on purpose. It is the case
   * worth exercising through the filter, because the document that comes out
   * differs from the untranslated one in its `status` and `type` and not only
   * in its wording — a test that used a case translating to 500 could pass
   * while the translation did nothing at all.
   */
  const aDependencyFailure = (name = 'SlowDown', httpStatusCode = 503): Error =>
    Object.assign(new Error('from the harness'), {
      name,
      $metadata: { httpStatusCode },
    });

  /**
   * A failure no translator claims: no `$metadata`, and not a Prisma error.
   * A socket-level code is exactly the case the AWS translator declines on
   * purpose, because it could as easily have come from the mail transport.
   */
  const anUnclaimedFailure = (): Error =>
    Object.assign(new Error('from the harness'), { code: 'ECONNREFUSED' });

  it('serves every error as application/problem+json', () => {
    const recorded = catchIt(new NotFoundException());

    expect(recorded.contentType).toBe('application/problem+json');
  });

  it('always emits the five required fields', () => {
    const recorded = catchIt(new NotFoundException(), '/api/v1/products/1');

    expect(Object.keys(recorded.body ?? {}).sort()).toEqual([
      'detail',
      'instance',
      'status',
      'title',
      'type',
    ]);
    expect(recorded.body?.instance).toBe('/api/v1/products/1');
  });

  /**
   * `message` arrives in two shapes and both have to end up as a string
   * `detail`: `ValidationPipe` throws it as an array and every other
   * exception as a single string. Flattening only one leaves the 400
   * breaking its own schema while the 404 passes.
   */
  it('flattens the array message of a validation failure into a string', () => {
    const recorded = catchIt(
      new BadRequestException([
        'email must be an email',
        'password must be longer than or equal to 12 characters',
      ]),
    );

    expect(typeof recorded.body?.detail).toBe('string');
    expect(recorded.body?.detail).toContain('email must be an email');
    expect(recorded.body?.detail).toContain('12 characters');
  });

  it('keeps a plain string message as the detail', () => {
    const recorded = catchIt(new ForbiddenException('you cannot'));

    expect(recorded.body?.detail).toBe('you cannot');
  });

  it('maps each HTTP status to the problem type the contract declares', () => {
    expect(catchIt(new BadRequestException()).body?.type).toBe(
      Problems.validation.type,
    );
    expect(catchIt(new UnauthorizedException()).body?.type).toBe(
      Problems.unauthorized.type,
    );
    expect(catchIt(new ForbiddenException()).body?.type).toBe(
      Problems.forbidden.type,
    );
    expect(catchIt(new NotFoundException()).body?.type).toBe(
      Problems.notFound.type,
    );
  });

  it('serves a ProblemException with its own type and extensions', () => {
    const { host, recorded } = anArgumentsHost();
    filter.catch(
      new ProblemException(
        Problems.orderAlreadyPending,
        'Pay the pending order or wait.',
        { expiresAt: '2026-08-28T23:00:00Z' },
      ),
      host,
    );

    expect(recorded.status).toBe(409);
    expect(recorded.body?.type).toBe(Problems.orderAlreadyPending.type);
    expect(recorded.body?.expiresAt).toBe('2026-08-28T23:00:00Z');
  });

  /**
   * An unhandled error comes out as a generic 500 and **its message never
   * travels to the client**. Letting it through would expose internal detail
   * in a public response.
   */
  it('hides the message of an unhandled error behind a generic 500', () => {
    const recorded = catchIt(
      new Error('connect ECONNREFUSED 10.0.0.7:5432 password=secret'),
    );

    expect(recorded.status).toBe(500);
    expect(recorded.body?.type).toBe(Problems.internalError.type);
    expect(JSON.stringify(recorded.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(recorded.body)).not.toContain('secret');
  });

  /**
   * RFC 9110 15.5.2 requires a 401 to carry `WWW-Authenticate`, and the
   * contract declares it. A guard that already set it keeps its value,
   * which is what distinguishes "you sent no token" from "yours is invalid".
   */
  it('adds a Bearer challenge to a 401 that arrives without one', () => {
    const recorded = catchIt(new UnauthorizedException());

    expect(recorded.headers['WWW-Authenticate']).toBe('Bearer');
  });

  it('does not overwrite a challenge the guard already set', () => {
    const { host, recorded } = anArgumentsHost();
    const response = host.switchToHttp().getResponse<{
      setHeader: (n: string, v: string) => void;
    }>();
    response.setHeader(
      'WWW-Authenticate',
      'Bearer error="invalid_token", error_description="The access token expired"',
    );

    filter.catch(new UnauthorizedException(), host);

    expect(recorded.headers['WWW-Authenticate']).toContain('invalid_token');
  });

  it('leaves a non-401 without a challenge header', () => {
    const recorded = catchIt(new ForbiddenException());

    expect(recorded.headers['WWW-Authenticate']).toBeUndefined();
  });

  /**
   * The branch the translators added. `catchIt` takes any thrown value, and
   * `aDependencyFailure` and `anUnclaimedFailure` above build its two
   * inputs.
   *
   * The first is about the whole document and not only its status: a
   * translated problem must carry the `type` of the catalog entry the
   * translator chose, because two entries can share a status and only the
   * type tells a client which one it got.
   */
  it('serves the catalog entry a translator chose instead of a generic 500', () => {
    const recorded = catchIt(aDependencyFailure());

    expect(recorded.body?.type).toBe(Problems.serviceUnavailable.type);
  });

  it('keeps the five required fields when the problem came from a translator', () => {
    const recorded = catchIt(aDependencyFailure());

    expect(Object.keys(recorded.body ?? {}).sort()).toEqual([
      'detail',
      'instance',
      'status',
      'title',
      'type',
    ]);
  });

  it('still serves the generic 500 for an error no translator claims', () => {
    const unclaimed = catchIt(anUnclaimedFailure());
    const unhandled = catchIt(
      new Error('from the existing unhandled-error test'),
    );

    expect(unclaimed.status).toBe(500);
    expect(unclaimed.body).toEqual(unhandled.body);
  });
  it('does not hand a ProblemException or an HttpException to a translator', () => {
    const translateProblem = jest.spyOn(translators, 'translateProblem');

    catchIt(new ProblemException(Problems.conflict, 'from the harness'));
    catchIt(new ForbiddenException('from the harness'));

    expect(translateProblem).not.toHaveBeenCalled();
    translateProblem.mockRestore();
  });
});
