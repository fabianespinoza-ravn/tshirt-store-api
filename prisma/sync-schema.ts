/**
 * Pre-deploy schema sync, without a migration history and without the
 * interactive gate of `prisma db push`.
 *
 * `db push` decides on its own what is risky and stops to ask — and adding
 * a unique constraint to a table that already exists counts, because the
 * push could fail on duplicates. In a non-interactive pipeline nobody
 * answers, so the push aborts unless `--accept-data-loss` is passed, and
 * that flag would also wave through a dropped column. This script keeps the
 * "declarative, no history" model and replaces the prompt with a rule the
 * repository controls:
 *
 *   1. `prisma migrate diff` computes the SQL that takes the live database
 *      to `schema.prisma`, and prints it, so the deploy log records exactly
 *      what ran.
 *   2. The plan is refused when it contains a statement class that loses
 *      data or locks rows out (see DESTRUCTIVE). Adding a column, a table,
 *      an index or a unique constraint passes; a unique constraint that
 *      meets duplicates fails at execution, loudly, and nothing is applied.
 *   3. `prisma db execute` applies the plan as one transaction.
 *
 * A destructive change that is meant — the "contract" half of an
 * expand-and-contract rollout — is allowed for a single deploy by setting
 * ALLOW_DESTRUCTIVE_SCHEMA_CHANGE=1 in that deploy's environment and
 * removing it afterwards; the override is named in the deploy log.
 *
 * The datasource URL is read the way the Prisma CLI always reads it, from
 * `schema.prisma`'s `env("DATABASE_URL")`, so the script never handles the
 * connection string itself.
 */
import { spawnSync } from 'node:child_process';

const PRISMA_CLI = require.resolve('prisma/build/index.js');
const SCHEMA = 'prisma/schema.prisma';
const OVERRIDE = 'ALLOW_DESTRUCTIVE_SCHEMA_CHANGE';

/** Exit code of `prisma migrate diff --exit-code` when the diff is not empty. */
const DIFF_NOT_EMPTY = 2;

/**
 * Statement classes the pipeline refuses on its own. Each loses data or
 * makes existing rows unreadable to the code that ships with the change.
 */
const DESTRUCTIVE: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { label: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  {
    label: 'ALTER COLUMN ... TYPE',
    pattern: /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
  },
  { label: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
  { label: 'DROP CONSTRAINT', pattern: /\bDROP\s+CONSTRAINT\b/i },
];

function prisma(args: string[], input?: string) {
  return spawnSync(process.execPath, [PRISMA_CLI, ...args], {
    input,
    encoding: 'utf8',
    env: process.env,
  });
}

export function destructiveStatementsIn(plan: string): string[] {
  return DESTRUCTIVE.filter(({ pattern }) => pattern.test(plan)).map(
    ({ label }) => label,
  );
}

function main(): void {
  const diff = prisma([
    'migrate',
    'diff',
    '--from-schema-datasource',
    SCHEMA,
    '--to-schema-datamodel',
    SCHEMA,
    '--script',
    '--exit-code',
  ]);

  if (diff.status === 0) {
    console.log('sync-schema: the database already matches schema.prisma.');
    return;
  }
  if (diff.status !== DIFF_NOT_EMPTY) {
    process.stderr.write(diff.stderr);
    throw new Error(`prisma migrate diff exited with ${String(diff.status)}`);
  }

  const plan = diff.stdout;
  console.log('sync-schema: plan\n' + plan.trim());

  const refused = destructiveStatementsIn(plan);
  if (refused.length > 0 && process.env[OVERRIDE] !== '1') {
    throw new Error(
      `sync-schema: the plan contains ${refused.join(', ')}; nothing was applied. ` +
        `If this contract step is intended, set ${OVERRIDE}=1 for this one deploy.`,
    );
  }
  if (refused.length > 0) {
    console.warn(
      `sync-schema: applying ${refused.join(', ')} because ${OVERRIDE}=1 is set.`,
    );
  }

  // One command, one transaction: a statement that fails — a unique index
  // meeting duplicates, say — rolls back everything before it.
  const applied = prisma(
    ['db', 'execute', '--schema', SCHEMA, '--stdin'],
    `BEGIN;\n${plan}\nCOMMIT;\n`,
  );
  if (applied.status !== 0) {
    process.stderr.write(applied.stderr);
    throw new Error(
      'sync-schema: prisma db execute failed; nothing was applied.',
    );
  }
  console.log('sync-schema: applied.');
}

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
