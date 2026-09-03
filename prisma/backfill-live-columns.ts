/**
 * One-time data backfill, not a recurring schema constraint: `prisma db
 * push` adds `live_email` and `live_user_id` as plain nullable columns with
 * no default, so every pre-existing row gets them as NULL. Without this,
 * `findLiveByEmail` and the token lookups in `auth.service.ts` — which now
 * query exclusively by the new columns — cannot find any account or token
 * that existed before this deploy.
 *
 * Idempotent and safe to run every time: each statement only fills a NULL
 * slot that its own condition says should hold a value, so re-running it
 * after a deploy where nothing changed is a no-op, and running it against
 * an empty database (a fresh local setup) does nothing at all.
 *
 * `$executeRaw` here is a one-off write to fix up existing data, not a
 * versioned schema definition — the distinction this repository dropped
 * migrations over. It runs through the ordinary Prisma client, is plain
 * TypeScript, and is never re-applied as part of the schema itself.
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const users = await prisma.$executeRaw`
      UPDATE users
      SET live_email = email
      WHERE deleted_at IS NULL AND live_email IS NULL
    `;
    const tokens = await prisma.$executeRaw`
      UPDATE email_verification_tokens
      SET live_user_id = user_id
      WHERE consumed_at IS NULL AND live_user_id IS NULL
    `;

    console.log(
      `Backfilled live_email on ${users} user(s) and live_user_id on ${tokens} token(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
