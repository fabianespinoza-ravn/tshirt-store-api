#!/usr/bin/env node
// How many comments the review action has left on this pull request.
//
// The workflow calls it twice, before and after the review, and treats a
// number that did not grow as a review that never happened. That is the
// failure worth catching: the action reports a refusal to review — a
// workflow file that differs from main's, an expired token — as a
// successful run with no output, which looks exactly like a clean review.
//
// Only this one author counts. A person or another bot commenting while the
// job runs must not be able to satisfy the check on its behalf.
//
// Asking `gh` for the logins rather than for a count is deliberate: with
// `--paginate` a count is printed once per page and has to be summed, and a
// pull request that grew past one page would silently undercount. A login
// per line concatenates across pages on its own.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const AUTHOR = 'claude[bot]';

// Top-level comments live under `issues`, line comments under `pulls`, and
// the action posts both.
const ENDPOINTS = ['issues', 'pulls'];

// The seam the suite replaces. In the workflow nothing sets it and this is
// the real binary; a test points it at a script that answers without a
// network. A path ending in `.mjs` is run through this Node rather than
// executed directly, because a shebang is not executable on every platform
// the suite runs on.
const GH = process.env.GH_BIN ?? 'gh';

function logins(repo, endpoint, pullRequest) {
  const args = [
    'api',
    `repos/${repo}/${endpoint}/${pullRequest}/comments`,
    '--paginate',
    '--jq',
    '.[].user.login',
  ];
  const output = GH.endsWith('.mjs')
    ? execFileSync(process.execPath, [GH, ...args], { encoding: 'utf8' })
    : execFileSync(GH, args, { encoding: 'utf8' });

  return output.split('\n').filter(Boolean);
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pullRequest = event.pull_request.number;
const repo = process.env.GITHUB_REPOSITORY;

const total = ENDPOINTS.reduce(
  (count, endpoint) =>
    count +
    logins(repo, endpoint, pullRequest).filter((l) => l === AUTHOR).length,
  0,
);

process.stdout.write(`${total}\n`);
