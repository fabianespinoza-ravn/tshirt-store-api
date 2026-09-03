import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaService } from '../prisma/prisma.service';

export type PrismaMock = DeepMockProxy<PrismaService>;

// Deep mock of PrismaService with $transaction already resolved for both of
// its shapes (an array of promises, or an interactive callback with `tx`);
// the callback receives the mock itself, so tx.user.create and
// prisma.user.create are the same spy function.
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

// Returns the mock to its initial state and rewires $transaction; calling it
// in beforeEach keeps the suite's outcome from depending on test order.
export function resetPrismaMock(prisma: PrismaMock): void {
  mockReset(prisma);
  prisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaMock) => unknown)(prisma) as never;
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}
