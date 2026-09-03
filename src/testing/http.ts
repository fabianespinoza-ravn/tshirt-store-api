import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import type { ProblemBody } from '../common/problem/problem.exception';

// Doubles for the HTTP side: ProblemDetailsFilter and the guards receive
// Express and Nest objects that can't really be constructed in a unit test.

// What the filter ended up writing to the response.
export interface RecordedResponse {
  status?: number;
  contentType?: string;
  body?: ProblemBody;
  headers: Record<string, unknown>;
}

// Express response reduced to what ProblemDetailsFilter touches:
// status().type().json() chained, plus getHeader/setHeader to decide
// whether a guard already set a WWW-Authenticate.
export function recordingResponse(): {
  response: unknown;
  recorded: RecordedResponse;
} {
  const recorded: RecordedResponse = { headers: {} };

  // `response` is returned by name and not as `this`: chaining with `this`
  // in an object literal leaves it typed as `any` and drags the error
  // through the whole `status().type().json()` chain.
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
    originalUrl: options.url ?? '/api/v1/resource',
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

// ExecutionContext for the guards: handler and controller matter because
// Reflector.getAllAndOverride reads metadata from both, so the real method
// and class carrying the decorator have to be passed in.
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
    originalUrl: '/api/v1/resource',
    method: 'GET',
  };

  const context = {
    getHandler: () => options.handler ?? (() => undefined),
    getClass: () => options.controller ?? class Anonymous {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, recorded };
}
