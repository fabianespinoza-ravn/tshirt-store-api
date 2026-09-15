import { HttpException } from '@nestjs/common';
import type { ProblemKind } from './problem.catalog';

/** Extra fields of a problem, like the `expiresAt` of `order-already-pending`. */
export type ProblemExtensions = Record<string, unknown>;

export interface ProblemBody extends ProblemExtensions {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

// The filter recognises this exception and serves it as-is, without guessing
// from the status code; instance isn't passed here because only the filter
// knows the request's URL.
export class ProblemException extends HttpException {
  constructor(
    readonly kind: ProblemKind,
    readonly detail: string,
    readonly extensions: ProblemExtensions = {},
  ) {
    super(
      { type: kind.type, title: kind.title, status: kind.status, detail },
      kind.status,
    );
  }
}
