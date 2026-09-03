#!/usr/bin/env node
// Fails when a tracked file cites a Markdown file that isn't tracked.
//
// Root-level *.md files are untracked planning notes (see .gitignore), so a
// citation of one from a tracked file points at nothing on a fresh clone.
// The same check catches a docs/ file renamed while a comment still names
// the old file. Runs as part of `npm run lint:ci`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const trackedNames = new Set(tracked.map((file) => basename(file)));

// A path-like token that ends in `.md`, once URLs are out of the way.
const citation = /[\w./-]*[\w-]\.md\b/g;
const url = /\bhttps?:\/\/\S+/g;
const skipped = /(^|\/)package-lock\.json$/;

const findings = [];
for (const file of tracked) {
  if (skipped.test(file)) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue; // binary
  bytes
    .toString('utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const [ref] of line.replace(url, '').matchAll(citation)) {
        if (!trackedNames.has(basename(ref))) {
          findings.push(`${file}:${index + 1}: ${ref} is not a tracked file`);
        }
      }
    });
}

if (findings.length > 0) {
  console.error(findings.join('\n'));
  console.error(
    `\n${findings.length} citation(s) of an untracked Markdown file. Root-level notes are local: cite docs/ instead.`,
  );
  process.exit(1);
}
console.log(
  `check-md-citations: ${tracked.length} tracked files, no dangling Markdown citation.`,
);
