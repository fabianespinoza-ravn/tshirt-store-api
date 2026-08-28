import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaService } from '../prisma/prisma.service';

export type PrismaMock = DeepMockProxy<PrismaService>;

// Mock profundo de PrismaService con $transaction ya resuelto para sus dos formas (array de promesas, o callback interactivo con `tx`); el callback recibe el propio mock, así que tx.user.create y prisma.user.create son la misma función espía.
export function createPrismaMock(): PrismaMock {
  const prisma = mockDeep<PrismaService>();

  prisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaMock) => unknown)(prisma) as never;
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  return prisma;
}

// Devuelve el mock a su estado inicial y vuelve a cablear $transaction; llamarlo en beforeEach evita que el resultado de la suite dependa del orden de los tests.
export function resetPrismaMock(prisma: PrismaMock): void {
  mockReset(prisma);
  prisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaMock) => unknown)(prisma) as never;
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}
