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

const PROBLEM_JSON = 'application/problem+json';

// Traduce cualquier excepción al documento RFC 9457 que declara el contrato: Nest sirve {message, error, statusCode} como application/json, y el contrato exige {type, title, status, detail, instance} como application/problem+json.
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const instance = request.originalUrl;

    const body = this.toProblem(exception, instance);

    if (body.status >= 500) {
      // El detalle que se envía es genérico; el que sirve para depurar se queda
      // aquí. Un stack trace en la respuesta es una filtración, no una ayuda.
      this.logger.error(
        `${request.method} ${instance} -> ${body.status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (body.status === 401 && !response.getHeader('WWW-Authenticate')) {
      // RFC 9110 15.5.2 obliga a que un 401 lleve esta cabecera, y el contrato
      // la declara con el valor de RFC 6750. Un guard que no la ponga la recibe
      // aquí, sin `error=` porque a esta altura no se sabe si llegó un token.
      response.setHeader('WWW-Authenticate', 'Bearer');
    }

    response.status(body.status).type(PROBLEM_JSON).json(body);
  }

  private toProblem(exception: unknown, instance: string): ProblemBody {
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

    const kind = Problems.internalError;
    return {
      type: kind.type,
      title: kind.title,
      status: kind.status,
      detail: 'An unexpected error occurred while processing the request.',
      instance,
    };
  }

  // message llega como array (ValidationPipe) o como cadena (el resto de excepciones); tratar sólo una de las dos formas deja al 400 incumpliendo su propio esquema.
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
