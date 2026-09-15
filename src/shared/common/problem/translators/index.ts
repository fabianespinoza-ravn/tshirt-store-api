import {
  originalErrorLabel,
  type ProblemTranslation,
} from './problem-translator';
import { translateAwsError } from './aws-s3.translator';
import { translatePrismaError } from './prisma.translator';
import { translateStripeError } from './stripe.translator';

export {
  GENERIC_INTERNAL_DETAIL,
  type ProblemTranslation,
  type ProblemTranslator,
} from './problem-translator';

/**
 * The one translator with a caller of its own.
 *
 * `PaymentLinksService` classifies a refused Stripe call itself, so that the
 * log line can name the SKU the refusal was for — something the filter, which
 * sees only the error, cannot do. It is the same function registered below,
 * so both routes to the client answer identically.
 */
export { translateStripeError } from './stripe.translator';

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
 * These three cannot claim the same error — each recognises a shape the
 * other two decline, an AWS `$metadata`, a Prisma `P####` and a Stripe
 * `type` — so the order here is alphabetical rather than meaningful. It
 * stays safe only while every translator keeps declining what it cannot
 * identify; a translator that claimed bare socket errors would start
 * stealing them from whichever one is listed after it.
 */
const TRANSLATORS = [
  translateAwsError,
  translatePrismaError,
  translateStripeError,
];

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
