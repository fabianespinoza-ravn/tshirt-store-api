import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import type { ProblemBody } from '../common/problem/problem.exception';

// Dobles del lado HTTP: ProblemDetailsFilter y los guards reciben objetos de Express y de Nest que no se pueden construir de verdad en un test unitario.

// Lo que el filtro acabó escribiendo en la respuesta.
export interface RecordedResponse {
  status?: number;
  contentType?: string;
  body?: ProblemBody;
  headers: Record<string, unknown>;
}

// Respuesta de Express reducida a lo que ProblemDetailsFilter toca: status().type().json() encadenados, más getHeader/setHeader para decidir si ya hay un WWW-Authenticate puesto por el guard.
export function recordingResponse(): {
  response: unknown;
  recorded: RecordedResponse;
} {
  const recorded: RecordedResponse = { headers: {} };

  // Se devuelve `response` por su nombre y no `this`: encadenar con `this` en un
  // objeto literal lo deja tipado como `any` y arrastra el error por toda la
  // cadena `status().type().json()`.
  const response = {
    getHeader: (name: string) => recorded.headers[name],
    setHeader: (name: string, value: unknown) => {
      recorded.headers[name] = value;
    },
    status: (code: number) => {
      recorded.status = code;
      return response;
    },
    type: (value: string) => {
      recorded.contentType = value;
      return response;
    },
    json: (body: ProblemBody) => {
      recorded.body = body;
      return response;
    },
  };

  return { response, recorded };
}

export function anArgumentsHost(
  options: { url?: string; method?: string } = {},
): { host: ArgumentsHost; recorded: RecordedResponse } {
  const { response, recorded } = recordingResponse();
  const request = {
    originalUrl: options.url ?? '/api/v1/recurso',
    method: options.method ?? 'GET',
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, recorded };
}

// ExecutionContext para los guards: handler y controller importan porque Reflector.getAllAndOverride lee la metadata de los dos, así que hay que pasar el método y la clase reales que llevan el decorador.
export function anExecutionContext(options: {
  user?: AuthenticatedUser;
  handler?: unknown;
  controller?: unknown;
  headers?: Record<string, string>;
}): { context: ExecutionContext; recorded: RecordedResponse } {
  const { response, recorded } = recordingResponse();
  const request = {
    user: options.user,
    headers: options.headers ?? {},
    originalUrl: '/api/v1/recurso',
    method: 'GET',
  };

  const context = {
    getHandler: () => options.handler ?? (() => undefined),
    getClass: () => options.controller ?? class Anonima {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, recorded };
}
