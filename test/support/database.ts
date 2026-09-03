import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';

// Every table the schema declares, by its physical name, read from the
// client's DMMF so a model added later is truncated without touching this
// file. Truncate-and-reseed rather than a rollback per test: the code under
// test opens its own transactions, and a rollback wrapped around them would
// not survive the first checkout.
const TABLES = Prisma.dmmf.datamodel.models.map(
  (model) => model.dbName ?? model.name,
);

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const list = TABLES.map((table) => `"${table}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}
