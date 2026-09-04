import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemForStatus, Problems } from '../problem/problem.catalog';
import {
  ProblemException,
  type ProblemBody,
} from '../problem/problem.exception';
import {
  GENERIC_INTERNAL_DETAIL,
  translateProblem,
  type TranslatedProblem,
} from '../problem/translators';

const PROBLEM_JSON = 'application/problem+json';

// Translates any exception into the RFC 9457 document the contract declares:
// Nest serves {message, error, statusCode} as application/json, and the
// contract requires {type, title, status, detail, instance} as
// application/problem+json.
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const instance = request.originalUrl;

    // A foreign error — one thrown by Prisma or by the AWS SDK — is
    // classified once, and the answer feeds both the body and the log line.
    // The two shapes this filter already understands are never handed to a
    // translator: they were built here on purpose and there is nothing to
    // classify.
    const translation =
      exception instanceof ProblemException ||
      exception instanceof HttpException
        ? undefined
        : translateProblem(exception);

    const body = this.toProblem(exception, instance, translation);

    if (translation) {
      // What the client reads never names the subsystem that failed. This
      // line does, because a translated 503 that logged nothing would be a
      // quieter version of the 500 it replaced, and the point of the
      // translation is to make the failure legible, not to hide it.
      this.logger.warn(
        `${request.method} ${instance} -> ${body.status} (${translation.origin})`,
      );
    }

    if (body.status >= 500) {
      // The detail sent to the client is generic; the one useful for
      // debugging stays here. A stack trace in the response is a leak, not
      // a courtesy.
      this.logger.error(
        `${request.method} ${instance} -> ${body.status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (body.status === 401 && !response.getHeader('WWW-Authenticate')) {
      // RFC 9110 15.5.2 requires a 401 to carry this header, and the contract
      // declares it with the RFC 6750 value. A guard that didn't set it gets
      // it here, without `error=` because at this point it isn't known
      // whether a token even arrived.
      response.setHeader('WWW-Authenticate', 'Bearer');
    }

    response.status(body.status).type(PROBLEM_JSON).json(body);
  }

  private toProblem(
    exception: unknown,
    instance: string,
    translation: TranslatedProblem | undefined,
  ): ProblemBody {
    if (exception instanceof ProblemException) {
      return {
        ...exception.extensions,
        type: exception.kind.type,
        title: exception.kind.title,
        status: exception.kind.status,
        detail: exception.detail,
        instance,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const kind = problemForStatus(status);
      return {
        type: kind.type,
        title: kind.title,
        status: kind.status,
        detail: this.detailFrom(exception),
        instance,
      };
    }

    // A translated error, and then the fallback. Both go through the same
    // shaping below, so a translation changes which catalog entry is served
    // and nothing else about the document.
    const kind = translation?.kind ?? Problems.internalError;
    return {
      type: kind.type,
      title: kind.title,
      status: kind.status,
      detail: translation?.detail ?? GENERIC_INTERNAL_DETAIL,
      instance,
    };
  }

  // message arrives as an array (ValidationPipe) or as a string (every other
  // exception); handling only one of the two shapes leaves the 400 violating
  // its own schema.
  private detailFrom(exception: HttpException): string {
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return payload;
    }

    const message = (payload as { message?: unknown }).message;

    if (Array.isArray(message)) {
      return message.map(String).join('; ');
    }

    if (typeof message === 'string' && message.length > 0) {
      return message;
    }

    return exception.message;
  }
}
