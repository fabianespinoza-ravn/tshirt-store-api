#!/usr/bin/env node
// Fails when `jest.coverageThreshold` is lower than the one on main.
//
// CLAUDE.md: the floor is raised when coverage improves and never lowered to
// make a pull request pass. That rule lived only in prose, which is the one
// place a rule cannot be enforced from. Runs as part of `npm run lint:ci`,
// so both the pre-commit hook and the `verify` job apply it.
//
// The comparison is against main, not against HEAD: in CI the working tree
// and HEAD are the same commit, so a HEAD baseline would compare the change
// with itself and pass everything.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FIELD = 'jest.coverageThreshold.global';

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

/**
 * The checkout is shallow in CI (`actions/checkout` fetches one commit), so
 * `origin/main` usually has to be fetched before it can be read. When there
 * is no remote at all — a fresh clone with no network, someone's fork — the
 * check reports that it could not run rather than failing the build for a
 * reason that has nothing to do with the change.
 */
function baselineRef() {
  if (
    tryGit(['rev-parse', '--verify', '--quiet', 'origin/main']) !== undefined
  ) {
    return 'origin/main';
  }
  // A successful `git fetch` prints nothing, so its result is compared
  // against `undefined` rather than tested for truth: an empty string is
  // what success looks like here, and reading it as failure would have made
  // this check skip itself in CI, where the checkout is shallow and the
  // fetch is the only way `main` arrives.
  if (
    tryGit(['fetch', '--no-tags', '--depth=1', 'origin', 'main']) !== undefined
  ) {
    return 'FETCH_HEAD';
  }
  return undefined;
}

function thresholdOf(source, where) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${where}: not valid JSON`);
  }
  return parsed?.jest?.coverageThreshold?.global;
}

const current = thresholdOf(
  readFileSync('package.json', 'utf8'),
  'package.json',
);
if (!current) {
  console.error(`check-coverage-floor: package.json has no ${FIELD}.`);
  process.exit(1);
}

// Skipping is for a clone with no remote, not for CI. A check that cannot
// run is a check that did not run, and this repository has already been
// burned once by a green mark that meant nothing.
function unavailable(reason) {
  if (process.env.CI) {
    console.error(
      `check-coverage-floor: ${reason}, and CI is where this must run.`,
    );
    process.exit(1);
  }
  console.log(`check-coverage-floor: ${reason}, skipped.`);
  process.exit(0);
}

const ref = baselineRef();
if (!ref) {
  unavailable('no main to compare against');
}

const baselineSource = tryGit(['show', `${ref}:package.json`]);
if (!baselineSource) {
  unavailable(`${ref} has no package.json`);
}

const baseline = thresholdOf(baselineSource, `${ref}:package.json`);
if (!baseline) {
  unavailable(`${ref} has no ${FIELD}`);
}

// A metric dropped from the object is a floor of zero, so absence is a
// lowering and not an exemption.
const lowered = Object.entries(baseline).flatMap(([metric, was]) => {
  const now = current[metric];
  if (typeof now !== 'number') return [`${metric}: ${was} on main, now absent`];
  return now < was ? [`${metric}: ${was} on main, ${now} here`] : [];
});

if (lowered.length > 0) {
  console.error(lowered.join('\n'));
  console.error(
    `\n${FIELD} may not go down. Raise the floor when coverage improves; never lower it to make a pull request pass (CLAUDE.md, Tests). If coverage genuinely dropped, write the missing tests instead.`,
  );
  process.exit(1);
}

const raised = Object.entries(current).filter(
  ([metric, now]) =>
    typeof baseline[metric] === 'number' && now > baseline[metric],
);
console.log(
  raised.length > 0
    ? `check-coverage-floor: floor raised on ${raised.map(([metric]) => metric).join(', ')}.`
    : 'check-coverage-floor: floor unchanged.',
);
