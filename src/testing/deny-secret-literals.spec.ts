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
 * **What it catches, and the edge that is left.** The prefixed formats —
 * Stripe, GitHub, an AWS access key id, a JWT, a private key block — are
 * caught wherever they appear. An AWS *secret* key has no prefix, so it is
 * caught by the name it is assigned to, and that name is matched in any
 * casing: `API_KEY` in configuration and the `apiKey` this codebase writes
 * for locals both count. Only the value half is case-sensitive, which is
 * what keeps a placeholder writable. What no name-based rule can reach is
 * key material under a name that says nothing — `const value`, `const s` —
 * and that is the edge, stated so nobody discovers it by accident.
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

    it('refuses the same secret under the camelCase name a local would use', () => {
      // The rule the hook leans on for unprefixed key material is the
      // variable's name, and dropping a case-insensitive flag once made
      // that half stop matching anything but SCREAMING_SNAKE — so a real
      // key under the casing this codebase actually writes was let through
      // in silence. This is the case that says it must not be.
      const name = 'api' + 'Key';
      const secret = 'wJalrXUtnFEMI7K7' + 'MDENGbPxRfiCYEXAMPLEKEY';

      expect(denies(`const ${name} = '${secret}';`)).toBe(true);
    });

    it('refuses a connection string whose password is not a placeholder', () => {
      const prefix = 'postgresql://user:';
      const password = 'P4sswordWith' + 'EnoughEntropy';

      expect(denies(`${prefix}${password}@db.example.test:5432/store`)).toBe(
        true,
      );
    });
  });

  describe('what it must let through, or it stops being usable', () => {
    it('allows a credential-named variable holding a printable fixture', () => {
      // The name matches the rule and the value does not, which is the
      // whole of the entropy check: no upper case means no key material.
      // With the name half matched case-insensitively this is the case
      // that keeps the hook usable, because it is the shape ordinary code
      // takes — and it is why the value half must stay case-sensitive.
      const name = 'pass' + 'word';

      expect(denies(`const ${name} = "probe-value-0123456789";`)).toBe(false);
    });

    it('allows the placeholder shapes the environment template carries', () => {
      const name = 'AWS_SECRET_ACCESS' + '_KEY';

      expect(denies(`${name}=tshirt-local-dev`)).toBe(false);
    });

    it('allows a reference to process.env rather than a value', () => {
      // The name matches and the reference is what saves it: a dot is not
      // in the value's character class, so what the rule weighs is
      // `process`, which is neither long enough nor key material. This is
      // the shape CLAUDE.md tells a test that needs a secret to use.
      expect(denies('SMTP_PASSWORD: process.env.SMTP_PASSWORD')).toBe(false);
    });

    it('allows the local connection strings committed in this repository', () => {
      const tshirt = 'postgresql://tshirt:' + 'tshirt@localhost:5433/store';
      const ci = 'postgresql://ci:' + 'ci@localhost:5432/store';

      expect(denies(`${tshirt}\n${ci}`)).toBe(false);
    });
  });
});
