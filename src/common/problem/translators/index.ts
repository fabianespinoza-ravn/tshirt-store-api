import {
  originalErrorLabel,
  type ProblemTranslation,
} from './problem-translator';
import { translateAwsError } from './aws-s3.translator';
import { translatePrismaError } from './prisma.translator';

export {
  GENERIC_INTERNAL_DETAIL,
  type ProblemTranslation,
  type ProblemTranslator,
} from './problem-translator';

/**
 * A translation, plus the label of the error it came from.
 *
 * The label exists so the filter can log what was actually thrown. Without
 * it a translation trades a loud 500 carrying a stack for a quiet 503
 * carrying nothing, and the day P2024 starts firing in bulk nobody notices.
 * It never travels to the client: it goes in the log line only.
 */
export interface TranslatedProblem extends ProblemTranslation {
  origin: string;
}

/**
 * Order matters only in that the first translator to claim an error wins.
 * These two cannot both claim the same one — a Prisma error is not an AWS
 * error — so the order here is alphabetical rather than meaningful.
 */
const TRANSLATORS = [translateAwsError, translatePrismaError];

/**
 * Classifies a foreign error into an entry of the `Problems` catalog.
 *
 * `undefined` means no translator recognised it, and the caller keeps doing
 * what it did before: a generic 500. That fallback is the reason this can be
 * added to safely — a translator that covers too little costs nothing, while
 * one that covers too much serves a misclassified failure as though we had
 * understood it.
 */
export function translateProblem(
  error: unknown,
): TranslatedProblem | undefined {
  for (const translate of TRANSLATORS) {
    const translation = translate(error);

    if (translation) {
      return { ...translation, origin: originalErrorLabel(error) };
    }
  }

  return undefined;
}
