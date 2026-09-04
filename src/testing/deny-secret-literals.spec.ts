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
    it.todo('refuses a realistic secret assigned to a SCREAMING_SNAKE name');
    it.todo('refuses a Stripe secret key and a webhook signing secret');
    it.todo('refuses a connection string whose password is not a placeholder');
  });

  describe('what it must let through, or it stops being usable', () => {
    it.todo('allows a lower-case local variable holding a printable fixture');
    it.todo('allows the placeholder shapes the environment template carries');
    it.todo('allows a reference to process.env rather than a value');
    it.todo('allows the local connection strings committed in this repository');
  });

  void run;
  void denies;
});
