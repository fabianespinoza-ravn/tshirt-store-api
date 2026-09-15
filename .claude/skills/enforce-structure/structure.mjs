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
const ALIAS = process.argv.includes('--alias');

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
const ROOT = layout.root;
const RESERVED = new Set(Object.values(layout.reserved));
const DOMAIN_SHARED = layout.reserved.shared;

const holdsModule = (dir) =>
  existsSync(abs(dir)) && readdirSync(abs(dir)).some((f) => f.endsWith('.module.ts'));

// Membership in a domain is a decision, not something a folder's contents
// reveal: nothing about `cart/` says it belongs to checkout. The config
// declares it, this reports whatever is not there yet, and `--apply` moves
// it. What the structural rules below enforce is the shape, which is what
// keeps holding once everything has arrived.
function declaredPlacements() {
  const out = [];
  for (const [domain, spec] of Object.entries(layout.domains ?? {})) {
    for (const member of spec.members ?? []) {
      out.push({ from: `${ROOT}/${member}`, to: `${ROOT}/${domain}/${member}` });
    }
    if (spec.shared) {
      out.push({
        from: `${ROOT}/${spec.shared}`,
        to: `${ROOT}/${domain}/${DOMAIN_SHARED}`,
      });
    }
  }
  return out.filter((m) => existsSync(abs(m.from)));
}

function check() {
  const findings = [];
  const allowed = new Set(layout.rootFiles);

  for (const m of declaredPlacements()) {
    findings.push({
      path: m.from,
      kind: 'move-to-domain',
      from: m.from,
      to: m.to,
      message: `is declared as part of ${m.to.split('/')[1]}, so it belongs at ${m.to}`,
    });
  }

  for (const entry of readdirSync(abs(ROOT), { withFileTypes: true })) {
    const name = entry.name;
    const path = `${ROOT}/${name}`;

    if (entry.isFile()) {
      if (!allowed.has(name)) {
        findings.push({
          path,
          kind: 'stray-root-file',
          message: `sits loose at ${ROOT}/ but is not a declared entry point`,
        });
      }
      continue;
    }
    if (RESERVED.has(name)) continue;

    // A simple domain holds its own module and nothing further to check.
    if (existsSync(abs(`${path}/${name}.module.ts`))) continue;
    // A folder still waiting to be gathered is already reported above.
    if (findings.some((f) => f.from === path)) continue;

    let sawModule = false;
    for (const child of readdirSync(abs(path), { withFileTypes: true })) {
      const childPath = `${path}/${child.name}`;
      if (child.isFile()) {
        if (child.name.endsWith('.ts')) {
          findings.push({
            path: childPath,
            kind: 'loose-in-domain',
            message: `sits directly in a domain; it belongs to a module or to ${name}/${DOMAIN_SHARED}/`,
          });
        }
        continue;
      }
      if (child.name === DOMAIN_SHARED) continue;
      if (holdsModule(childPath)) {
        sawModule = true;
        continue;
      }
      findings.push({
        path: childPath,
        kind: 'not-a-module',
        message: `sits inside a domain but holds no module file`,
      });
    }
    if (!sawModule) {
      findings.push({
        path,
        kind: 'not-a-domain',
        message: `is neither a module nor a folder of modules`,
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

// A path also travels inside quoted strings: an ESLint `ignores` glob, a
// restricted-import message, a fixture path. Those break as silently as an
// import does — more so, because a glob that matches nothing turns a rule
// off instead of failing. Prose in comments is left alone: rewording is a
// judgement call, and `audit-repo-docs` reports what is left.
const TEXT_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|prisma|sql)$/;
// Single and double quotes only, matched one line at a time. A backtick is
// a template literal in code but emphasis in a comment, and prose carries
// apostrophes — pairing quotes across a whole file lets one `doesn't` shift
// every match after it, which is how a glob three hundred lines later gets
// skipped. A line is the unit where that cannot happen.
const QUOTED = /(['"])((?:[^'"\\]|\\.)*?)\1/g;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|#)/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rewriteQuotedPaths(moves, mapPath, trackedText) {
  let touched = 0;
  // A move only counts when a path boundary follows it, so moving a folder
  // named catalog never rewrites the middle of a sibling named catalogue.
  const rules = moves.map((m) => ({
    re: new RegExp(`${escapeRe(m.from)}(?=/|$)`, 'g'),
    to: m.to,
  }));

  for (const file of trackedText) {
    const here = mapPath(file);
    if (!existsSync(abs(here))) continue;
    const before = readFileSync(abs(here), 'utf8');
    const after = before
      .split('\n')
      .map((line) => {
        if (COMMENT_LINE.test(line)) return line;
        return line.replace(QUOTED, (whole, quote, body) => {
          let out = body;
          for (const r of rules) out = out.replace(r.re, r.to);
          return out === body ? whole : `${quote}${out}${quote}`;
        });
      })
      .join('\n');
    if (after !== before) {
      writeFileSync(abs(here), after);
      touched += 1;
    }
  }
  return touched;
}

// ---------- aliasing ----------
// An import that stays inside its own top-level folder keeps its relative
// form: `./orders.service` says more about locality than `@checkout/orders/
// orders.service` does. Only a specifier that leaves the folder is worth
// naming the destination for.
function aliasTargets() {
  const cfg = layout.alias;
  if (!cfg) return null;
  const tops = new Set(cfg.of);
  return {
    prefix: cfg.prefix,
    tops,
    resolve(target) {
      const parts = target.split('/');
      if (parts[0] !== ROOT || !tops.has(parts[1])) return null;
      return { top: parts[1], rest: parts.slice(2).join('/') };
    },
  };
}

function relativeEscapes(file, a) {
  // A spec living outside the root escapes on every import it makes into a
  // domain; a file inside one escapes only when it leaves that one.
  return !file.startsWith(`${ROOT}/${a.top}/`);
}

function aliasPass(write) {
  const alias = aliasTargets();
  if (!alias) return { files: 0, specifiers: 0 };
  let files = 0;
  let specifiers = 0;

  for (const file of trackedSources()) {
    const before = readFileSync(abs(file), 'utf8');
    const after = before.replace(SPECIFIER, (whole, kw, quote, spec) => {
      const a = alias.resolve(posixResolve(posixDirname(file), spec));
      if (!a || !relativeEscapes(file, a)) return whole;
      specifiers += 1;
      return `${kw}${quote}${alias.prefix}${a.top}/${a.rest}${quote}`;
    });
    if (after !== before) {
      files += 1;
      if (write) writeFileSync(abs(file), after);
    }
  }
  return { files, specifiers };
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

  const trackedText = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map(toPosix)
    .filter((f) => TEXT_FILE.test(f));
  const rewired = rewriteQuotedPaths(moves, mapPath, trackedText);

  return { moved: moves.length, touched, rewired };
}

// ---------- run ----------
const findings = check();

if (findings.length > 0) {
  console.log(`## Layout violations (${findings.length})`);
  for (const f of findings) console.log(`${f.path}: ${f.message}`);
}

if (ALIAS) {
  const { files, specifiers } = aliasPass(true);
  console.log(
    `\nAliased ${specifiers} cross-domain specifier(s) in ${files} file(s).`,
  );
  console.log(
    'This only rewrote the imports. Three resolvers have to agree with them,\n' +
      'and only two of them tell you when they do not:\n' +
      '  · tsconfig `paths`  — type checking fails without it\n' +
      '  · the test runner   — suites fail to resolve without it\n' +
      '  · the build output  — says nothing either way. Whether an alias\n' +
      '    survives into the emitted JS depends on the builder: plain tsc\n' +
      '    leaves it, and the process then dies at require() time in\n' +
      '    production while `build` exits 0 and the entrypoint exists.\n' +
      '\n' +
      "Do not reason about which builder you have — grep the output:\n" +
      '  grep -rl \'require("@\' dist/    → must print nothing',
  );
  process.exit(0);
}

if (!APPLY) {
  const pending = aliasPass(false);
  if (pending.specifiers > 0) {
    console.log(
      `\n${pending.specifiers} cross-domain import(s) in ${pending.files} file(s) are still relative.`,
    );
    console.log('Run with --alias to name their domain instead.');
  }
  if (findings.length === 0 && pending.specifiers === 0) {
    console.log(`enforce-structure: ${ROOT}/ matches the declared layout.`);
    process.exit(0);
  }
  console.log('\nRun with --apply to move what is misplaced.');
  console.log("Verify with the repo's full CI sequence, not typecheck alone.");
  process.exit(1);
}

const moves = findings.filter((f) => f.kind === 'move-to-domain');
const unmovable = findings.filter((f) => f.kind !== 'move-to-domain');
if (unmovable.length > 0) {
  console.log(`\n${unmovable.length} finding(s) need a human decision, not a move:`);
  for (const f of unmovable) console.log(`  ${f.path}: ${f.message}`);
}
if (moves.length === 0) process.exit(1);

const { moved, touched, rewired } = apply(moves);
console.log(
  `\nMoved ${moved} folder(s); rewrote imports in ${touched} file(s) and quoted paths in ${rewired}.`,
);
console.log(
  'Now run this repo\'s full CI sequence. Typecheck alone is not enough: a\n' +
    'path glob that stops matching turns a lint rule off silently, and a\n' +
    'lengthened import can push a line past the formatter\'s width.',
);
