import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const HOOK = join(
  process.cwd(),
  '.claude',
  'hooks',
  'deny-secret-literals.mjs',
);

/**
 * The only piece of tooling here that can stop work, and the only one that
 * had no test until it was wrong.
 *
 * Its credential-name rule carried a case-insensitive flag, which made the
 * lookahead that required upper case — the check meant to tell real key
 * material from a placeholder — accept lower case as well. The rule then
 * fired on an ordinary lower-case local variable, and the entropy check it
 * was built around had never done anything. It was found by the hook
 * blocking a legitimate write, which is a bad way to find it.
 *
 * These run the hook as a process rather than importing it, because it is
 * ESM and this suite compiles to CommonJS — and because running it the way
 * the harness runs it is the only version that proves anything.
 *
 * **What it does not catch, stated so nobody discovers it by accident:**
 * unprefixed key material assigned to a lower-case name. The prefixed
 * formats — Stripe, GitHub, an AWS access key id, a JWT, a private key
 * block — are caught wherever they appear, but an AWS *secret* key has no
 * prefix, and the name-based rule only looks at SCREAMING_SNAKE because
 * matching any casing is what made it fire on ordinary code. That is a
 * deliberate trade and not an oversight; a test asserting the gap as a
 * feature would be worse than the gap.
 *
 * The payloads are assembled from fragments on purpose: the hook inspects
 * shell commands too, so a spec that spelled a credential out could not be
 * written to disk by an assistant working under it.
 */
describe('the deny-secret-literals hook', () => {
  const run = (content: string): string =>
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { content } }),
      encoding: 'utf8',
    });

  const denies = (content: string): boolean => run(content).trim().length > 0;

  describe('what it must refuse', () => {
    it('refuses a realistic secret assigned to a SCREAMING_SNAKE name', () => {
      const name = 'AWS_SECRET_ACCESS' + '_KEY';
      const secret = 'wJalrXUtnFEMI7K7' + 'MDENGbPxRfiCYEXAMPLEKEY';

      expect(denies(`${name}=${secret}`)).toBe(true);
    });

    it('refuses a Stripe secret key and a webhook signing secret', () => {
      const stripe = 'sk_' + 'test_' + 'A1'.repeat(12);
      const webhook = 'whsec_' + 'B2'.repeat(12);

      expect(denies(`${stripe}\n${webhook}`)).toBe(true);
    });

    it('refuses a connection string whose password is not a placeholder', () => {
      const prefix = 'postgresql://user:';
      const password = 'P4sswordWithEnoughEntropy';

      expect(denies(`${prefix}${password}@db.example.test:5432/store`)).toBe(
        true,
      );
    });
  });

  describe('what it must let through, or it stops being usable', () => {
    it('allows a lower-case local variable holding a printable fixture', () => {
      // A harmless value, not key material: the case is about the hook
      // leaving ordinary code alone. Asserting it with a realistic secret
      // would be documenting the limit below as if it were the feature.
      expect(denies('const sample = "probe-value-0123456789";')).toBe(false);
    });

    it('allows the placeholder shapes the environment template carries', () => {
      const name = 'AWS_SECRET_ACCESS' + '_KEY';

      expect(denies(`${name}=tshirt-local-dev`)).toBe(false);
    });

    it('allows a reference to process.env rather than a value', () => {
      // The name is upper case on purpose. With a lower-case one this
      // passes because the *name* does not match, and the reference path —
      // the thing the case is named after — is never reached.
      expect(denies('SMTP_PASSWORD: process.env.SMTP_PASSWORD')).toBe(false);
    });

    it('allows the local connection strings committed in this repository', () => {
      const tshirt = 'postgresql://tshirt:' + 'tshirt@localhost:5433/store';
      const ci = 'postgresql://ci:' + 'ci@localhost:5432/store';

      expect(denies(`${tshirt}\n${ci}`)).toBe(false);
    });
  });
});
