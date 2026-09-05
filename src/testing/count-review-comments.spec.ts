import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(
  process.cwd(),
  '.github',
  'scripts',
  'count-review-comments.mjs',
);

/**
 * The script the review workflow reads its verdict from.
 *
 * Its whole job is one number, and a wrong number is silent in both
 * directions: too high passes a review that never happened, too low fails
 * one that did. Neither shows up as an error, which is why it is worth a
 * test at all — the workflow around it cannot be unit-tested, so this is
 * the only part that can be pinned.
 *
 * `gh` is replaced through the `GH_BIN` seam rather than through the PATH,
 * because a stub on the PATH has to be executable and a shebang is not
 * portable to the machine this suite also runs on. The stub answers with a
 * login per line, which is exactly the shape
 * `gh api ... --paginate --jq '.[].user.login'` produces.
 */
describe('the review comment counter', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'review-count-'));
  const stub = join(workspace, 'gh-stub.mjs');
  const event = join(workspace, 'event.json');

  writeFileSync(
    event,
    JSON.stringify({ pull_request: { number: 42 } }),
    'utf8',
  );

  /**
   * Stands in for `gh`. It reads the endpoint out of the URL it was handed
   * — the same way the real one would route it — and prints whichever list
   * the case put in the environment. Exits non-zero when asked to, so the
   * failure path can be exercised.
   */
  writeFileSync(
    stub,
    [
      "const url = process.argv.find((a) => a.startsWith('repos/')) ?? '';",
      "if (process.env.STUB_FAILS === 'yes') {",
      // Escaped twice on purpose: this string is source code being written
      // to a file, so the file must receive a backslash and an n, not a
      // real line break. A single escape puts a literal newline inside a
      // quoted JS string and the stub stops parsing — a break only the
      // `gh` failure case would ever reach, which is why nothing caught it.
      "  process.stderr.write('gh: could not reach the API\\n');",
      '  process.exit(1);',
      '}',
      "const key = url.includes('/issues/') ? 'STUB_ISSUES' : 'STUB_PULLS';",
      "process.stdout.write(process.env[key] ?? '');",
    ].join('\n'),
    'utf8',
  );

  /** Runs the script under a given pair of answers and returns its number. */
  const count = (issues: string[], pulls: string[]): number =>
    Number(
      execFileSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GH_BIN: stub,
          GITHUB_EVENT_PATH: event,
          GITHUB_REPOSITORY: 'owner/repo',
          STUB_ISSUES: issues.map((l) => `${l}\n`).join(''),
          STUB_PULLS: pulls.map((l) => `${l}\n`).join(''),
          STUB_FAILS: 'no',
        },
      }).trim(),
    );

  /**
   * The same with the stub refusing. It **throws** rather than returning,
   * which is the behaviour under test: a `gh` that cannot answer must not
   * come back as zero, because zero is what a silent review looks like.
   */
  const runWithGhFailing = (): string =>
    String(
      execFileSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GH_BIN: stub,
          GITHUB_EVENT_PATH: event,
          GITHUB_REPOSITORY: 'owner/repo',
          STUB_FAILS: 'yes',
        },
      }).trim(),
    );

  const reviewer = 'claude[bot]';

  it('adds top-level comments to line comments, because the action posts both', () => {
    expect(count([reviewer, reviewer], [reviewer])).toBe(3);
  });

  it('counts only the reviewer, so a human cannot satisfy the check', () => {
    expect(count([reviewer, 'octocat'], ['octocat'])).toBe(1);
  });

  it('ignores another bot commenting mid-run', () => {
    expect(count(['dependabot[bot]'], ['github-actions[bot]'])).toBe(0);
  });

  it('returns zero when the reviewer never commented', () => {
    expect(count([], [])).toBe(0);
  });

  it('counts every login across paginated comment lists', () => {
    expect(
      count(
        [reviewer, reviewer, reviewer],
        [reviewer, reviewer, reviewer, reviewer],
      ),
    ).toBe(7);
  });

  it('fails rather than reporting zero when gh cannot answer', () => {
    expect(runWithGhFailing).toThrow();
  });
});
