import { HttpException } from '@nestjs/common';
import type { ProblemKind } from './problem.catalog';

/** Campos extra de un problema, como el `expiresAt` de `order-already-pending`. */
export type ProblemExtensions = Record<string, unknown>;

export interface ProblemBody extends ProblemExtensions {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

// El filtro reconoce esta excepción y la sirve tal cual, sin adivinar por el código de estado; instance no se pasa aquí porque sólo el filtro conoce la URL de la petición.
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
