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
 * Todo lo que se afirma aquí sale del contrato de la Semana 2: `ProblemDetails`
 * declara los cinco campos como requeridos, y `components/responses` sirve cada
 * error como `application/problem+json`.
 */
describe('ProblemDetailsFilter', () => {
  const filter = new ProblemDetailsFilter();

  const catchIt = (error: unknown, url = '/api/v1/recurso') => {
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
   * `message` llega en dos formas y las dos tienen que acabar en un `detail` que
   * sea cadena: `ValidationPipe` lo lanza como array y cualquier otra excepción
   * como una sola cadena. Aplanar sólo una deja el 400 rompiendo su propio
   * esquema mientras el 404 pasa.
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
    const recorded = catchIt(new ForbiddenException('no puedes'));

    expect(recorded.body?.detail).toBe('no puedes');
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
   * Un error no controlado sale como 500 genérico y **su mensaje no viaja al
   * cliente**. Filtrarlo sería exponer detalle interno en una respuesta pública.
   */
  it('hides the message of an unhandled error behind a generic 500', () => {
    const recorded = catchIt(
      new Error('connect ECONNREFUSED 10.0.0.7:5432 password=secreto'),
    );

    expect(recorded.status).toBe(500);
    expect(recorded.body?.type).toBe(Problems.internalError.type);
    expect(JSON.stringify(recorded.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(recorded.body)).not.toContain('secreto');
  });

  /**
   * RFC 9110 15.5.2 obliga a que un 401 lleve `WWW-Authenticate`, y el contrato
   * la declara. Un guard que ya la puso conserva su valor, que es el que
   * distingue "no mandaste token" de "el tuyo no vale".
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
});
