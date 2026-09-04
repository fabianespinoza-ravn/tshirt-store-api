import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { anArgumentsHost } from '../../testing/http';
import { Problems } from '../problem/problem.catalog';
import { ProblemException } from '../problem/problem.exception';
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
   * The branch the translators added. The harness above works unchanged —
   * `catchIt` takes any thrown value — and the assertions are the student's
   * (CLAUDE.md, Tests), because the branch under test is generated code.
   *
   * The case that matters is the last one: a `ProblemException` and a Nest
   * `HttpException` must never reach a translator. They were built here on
   * purpose and there is nothing to classify; a translator that got its
   * hands on one could rewrite a deliberate 409 into something else.
   */
  it.todo(
    'serves the catalog entry a translator chose instead of a generic 500',
  );
  it.todo(
    'keeps the five required fields when the problem came from a translator',
  );
  it.todo('still serves the generic 500 for an error no translator claims');
  it.todo(
    'does not hand a ProblemException or an HttpException to a translator',
  );
});
