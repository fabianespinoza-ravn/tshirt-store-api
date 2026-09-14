#!/usr/bin/env node
// Checks the repo against the layout declared in `layout.config.mjs`, and
// with `--apply` moves what doesn't conform and rewrites the imports that
// the move breaks.
//
// Run it with no arguments to see the findings. Nothing is written without
// `--apply`, and `--apply` never runs a git command: the move is on disk,
// staging and committing stay the author's.
//
// The rewrite has one rule and no special cases: resolve every relative
// specifier against the file's OLD location, map that target through the
// moves, then recompute the specifier from the file's NEW location. Inbound
// and outbound imports both fall out of it.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const APPLY = process.argv.includes('--apply');

const { layout } = await import(
  pathToFileURL(join(SKILL_DIR, 'layout.config.mjs')).href
);

const abs = (p) => join(REPO_ROOT, p.split('/').join(sep));
const toPosix = (p) => p.split(sep).join('/');

// ---------- posix path maths, independent of the host separator ----------
const posixDirname = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
};

function posixResolve(base, rel) {
  const out = [];
  for (const part of [...(base === '.' ? [] : base.split('/')), ...rel.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function posixRelative(from, to) {
  const f = from === '.' ? [] : from.split('/');
  const t = to.split('/');
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i += 1;
  const rel = [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
  return rel === '' ? '.' : rel;
}

// ---------- the layout check ----------
const sharedTier = layout.tiers.find((t) => t.requires === 'no-module-file');
const exemptDirs = new Set(
  layout.tiers.filter((t) => t.requires === 'any').map((t) => t.at),
);

const hasModuleFile = (dir, name) =>
  existsSync(abs(`${dir}/${name}.module.ts`)) ||
  readdirSync(abs(dir)).some((f) => f.endsWith('.module.ts'));

function check() {
  const root = layout.root;
  const findings = [];
  const allowed = new Set(layout.rootFiles);

  for (const entry of readdirSync(abs(root), { withFileTypes: true })) {
    const name = entry.name;
    const path = `${root}/${name}`;

    if (entry.isFile()) {
      if (!allowed.has(name)) {
        findings.push({
          path,
          kind: 'stray-root-file',
          message: `sits loose at ${root}/ but is not a declared entry point`,
        });
      }
      continue;
    }

    if (name === sharedTier.at) {
      for (const child of readdirSync(abs(path), { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        if (hasModuleFile(`${path}/${child.name}`, child.name)) {
          findings.push({
            path: `${path}/${child.name}`,
            kind: 'module-in-shared',
            message: `holds a module file, so it belongs flat under ${root}/`,
          });
        }
      }
      continue;
    }

    if (exemptDirs.has(name)) continue;

    if (!hasModuleFile(path, name)) {
      findings.push({
        path,
        kind: 'move-to-shared',
        from: path,
        to: `${root}/${sharedTier.at}/${name}`,
        message: `has no module file, so it belongs under ${root}/${sharedTier.at}/`,
      });
    }
  }
  return findings;
}

// ---------- the migration ----------
const SPECIFIER =
  /\b(from\s+|import\s*\(\s*|require\s*\(\s*|jest\.mock\s*\(\s*)(['"])(\.{1,2}\/[^'"]*)\2/g;

function trackedSources() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map(toPosix)
    .filter((f) => /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(f))
    .filter((f) => existsSync(abs(f)));
}

function apply(moves) {
  const mapPath = (p) => {
    for (const m of moves) {
      if (p === m.from) return m.to;
      if (p.startsWith(`${m.from}/`)) return m.to + p.slice(m.from.length);
    }
    return p;
  };

  const pending = new Map();
  let touched = 0;

  for (const file of trackedSources()) {
    const before = readFileSync(abs(file), 'utf8');
    const newFile = mapPath(file);
    const after = before.replace(SPECIFIER, (whole, kw, quote, spec) => {
      const targetOld = posixResolve(posixDirname(file), spec);
      const targetNew = mapPath(targetOld);
      if (targetNew === targetOld && newFile === file) return whole;
      let rel = posixRelative(posixDirname(newFile), targetNew);
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return `${kw}${quote}${rel}${quote}`;
    });
    if (after !== before) touched += 1;
    if (after !== before || newFile !== file) pending.set(newFile, after);
  }

  for (const m of moves) {
    mkdirSync(dirname(abs(m.to)), { recursive: true });
    renameSync(abs(m.from), abs(m.to));
  }
  for (const [file, text] of pending) writeFileSync(abs(file), text);

  return { moved: moves.length, touched };
}

// ---------- run ----------
const findings = check();

if (findings.length === 0) {
  console.log(`enforce-structure: ${layout.root}/ matches the declared layout.`);
  process.exit(0);
}

console.log(`## Layout violations (${findings.length})`);
for (const f of findings) console.log(`${f.path}: ${f.message}`);

if (!APPLY) {
  console.log('\nRun with --apply to move them and rewrite the imports.');
  console.log('Verify with `npm run typecheck`, `npm test`, `npm run build`.');
  process.exit(1);
}

const moves = findings.filter((f) => f.kind === 'move-to-shared');
const unmovable = findings.filter((f) => f.kind !== 'move-to-shared');
if (unmovable.length > 0) {
  console.log(`\n${unmovable.length} finding(s) need a human decision, not a move:`);
  for (const f of unmovable) console.log(`  ${f.path}: ${f.message}`);
}
if (moves.length === 0) process.exit(1);

const { moved, touched } = apply(moves);
console.log(`\nMoved ${moved} folder(s); rewrote imports in ${touched} file(s).`);
console.log('Now run `npm run typecheck` — it is the gate on whether this worked.');
