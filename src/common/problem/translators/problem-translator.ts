import type { ProblemKind } from '../problem.catalog';

/**
 * What a translator answers when it recognises a foreign error: an entry that
 * already exists in the `Problems` catalog, plus the detail the client reads.
 *
 * This is a classification, not a response. `ProblemDetailsFilter` remains
 * the only place that shapes an error body (CLAUDE.md), and a translator
 * never builds a problem document, never invents a `type` and never calls
 * `kind()` at runtime: the catalog is closed, and a translator only picks
 * from it.
 */
export interface ProblemTranslation {
  kind: ProblemKind;
  detail: string;
}

/**
 * A pure function from a foreign error — one thrown by Prisma, by the AWS
 * SDK, later by Stripe — to a catalog entry.
 *
 * `undefined` means "not mine": the registry moves on, and an error that no
 * translator claims stays the generic 500 it is today. Recognising too
 * little is safe, because the fallback is the honest answer. Recognising too
 * much is the bug, because a misclassified failure is served to the client
 * as if we had understood it.
 */
export type ProblemTranslator = (
  error: unknown,
) => ProblemTranslation | undefined;

/**
 * The detail of every 500, translated or not.
 *
 * It is shared with the filter's own fallback on purpose: if a translated
 * internal error read differently from an untranslated one, the wording
 * itself would tell a client which subsystem failed, and the translation
 * would have become an information channel. A 500 says the same sentence
 * whichever way it got there.
 */
export const GENERIC_INTERNAL_DETAIL =
  'An unexpected error occurred while processing the request.';

/**
 * The short identifier of the original error, for the log line that records
 * a translation.
 *
 * `code` first, because both Prisma's `P####` and Node's socket-level
 * `ECONNREFUSED` live there; then `name`, because the AWS SDK puts the
 * upstream error there and often nowhere else — `InvalidAccessKeyId` arrives
 * as a bare `S3ServiceException` whose class name says nothing useful; then
 * the constructor name as a last resort.
 *
 * It deliberately never returns the message: a Prisma connection error's
 * message can carry a host, a port and a user, and this string is written to
 * a log the same way for every error.
 */
export function originalErrorLabel(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return typeof error;
  }

  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === 'string' && code.length > 0) return code;
  if (typeof name === 'string' && name.length > 0) return name;

  return (error as { constructor?: { name?: string } }).constructor?.name ?? '';
}
