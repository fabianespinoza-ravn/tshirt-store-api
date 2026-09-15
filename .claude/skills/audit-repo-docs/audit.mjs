#!/usr/bin/env node
// Read-only auditor: portable across repos. Assumes only git + Node.
//
// Reports four categories of finding, never fixes anything:
//   1. Dangling Markdown citations   — a tracked file cites a `.md` that isn't tracked.
//   2. `.claude/**` structural gaps  — an agent/command/skill file missing frontmatter.
//   3. Long comment blocks           — candidates for ADR extraction (length + signal only;
//      the domain-modeling three-part test still has to be applied by a reader).
//   4. Doc-vs-code list drift        — optional, only runs if `watches.config.mjs` exists
//      next to this script. Each repo that wants this layer writes its own tiny config;
//      its absence just skips the layer, nothing else changes.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((f) => existsSync(join(REPO_ROOT, f)));
}

// ---------- 1. Dangling Markdown citations ----------
// Only a token carrying a `/` is treated as a path citation. A bare
// `foo.ts` is indistinguishable from a property access (`h.prisma`) or from
// prose (`Node.js`), which is why bare names are checked for `.md` alone —
// the one extension that never appears as an identifier.
const CITED_EXT = /\.(md|ts|tsx|mjs|cjs|js|json|ya?ml|prisma|sql)$/;
// Build output and ignored paths are named in documentation on purpose and
// are never tracked, so naming them is a reference, not a citation.
const NEVER_TRACKED = /^(dist|dist-deploy|node_modules|coverage)\/|^\.env/;
// `.gitignore` names untracked paths by definition; `package-lock.json`
// carries every dependency's own bin paths.
const NOT_PROSE = /(^|\/)(package-lock\.json|\.gitignore)$/;
// A path written as a template — `docs/adr/NNNN-slug.md`, `src/<name>/` —
// describes a shape, so there is nothing for it to resolve to.
const TEMPLATE_PATH = /[<>{}*]|([A-Z])\1{2,}/;

function checkCitations(tracked) {
  const trackedPaths = new Set(tracked);
  const trackedBasenames = new Set(tracked.map((f) => basename(f)));
  const trackedDirs = new Set(
    tracked.flatMap((f) => {
      const parts = f.split('/');
      return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    }),
  );
  const citation = /[\w./-]*[\w-]\.[a-z]+\b/g;
  // A directory citation counts only when rooted somewhere real, so prose
  // like "the views/ layer" is not mistaken for a path.
  const dirCitation =
    /\b(?:src|docs|scripts|prisma|test|\.claude|\.github)(?:\/[\w.-]+)+\/(?!\w)/g;
  const url = /\bhttps?:\/\/\S+/g;
  const findings = [];

  // A path may be written from anywhere above it — `common/ids.ts` in a
  // comment means `src/shared/common/ids.ts` — so a citation resolves when a
  // tracked path is it, or ends with it. A moved file stops matching either
  // way, which is the case worth catching.
  const resolves = (ref, universe) => {
    const p = ref.replace(/^\.?\//, '');
    if (universe.has(p)) return true;
    for (const t of universe) if (t.endsWith(`/${p}`)) return true;
    return false;
  };

  // Two ways a path can fail to resolve without being broken: it names a
  // dependency's own file, or it points at something outside this repo
  // entirely. Neither is this repo's to keep in sync.
  const topLevel = new Set(tracked.map((f) => f.split('/')[0]));
  const isExternal = (ref) => {
    const p = ref.replace(/^\.?\//, '');
    if (existsSync(join(REPO_ROOT, 'node_modules', p))) return true;
    return !topLevel.has(p.split('/')[0]);
  };

  const report = (file, i, ref, what) =>
    findings.push({
      file,
      line: i + 1,
      message: `cites \`${ref}\`, which is not ${what}`,
    });

  for (const file of tracked) {
    if (NOT_PROSE.test(file)) continue;
    const bytes = readFileSync(join(REPO_ROOT, file));
    if (bytes.includes(0)) continue; // binary
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        const prose = line.replace(url, '');
        for (const [ref] of prose.matchAll(citation)) {
          if (!CITED_EXT.test(ref) || NEVER_TRACKED.test(ref)) continue;
          if (TEMPLATE_PATH.test(ref)) continue;
          if (ref.includes('/')) {
            if (!resolves(ref, trackedPaths) && !isExternal(ref)) {
              report(file, i, ref, 'a tracked file');
            }
          } else if (ref.endsWith('.md') && !trackedBasenames.has(ref)) {
            report(file, i, ref, 'a tracked file');
          }
        }
        for (const [ref] of prose.matchAll(dirCitation)) {
          const dir = ref.replace(/\/$/, '');
          if (NEVER_TRACKED.test(dir)) continue;
          if (!resolves(dir, trackedDirs) && !isExternal(dir)) {
            report(file, i, ref, 'a tracked directory');
          }
        }
      });
  }
  return findings;
}

// ---------- 2. `.claude/**` structural completeness ----------
function checkClaudeFiles(tracked) {
  const findings = [];
  const candidates = tracked.filter(
    (f) =>
      /^\.claude\/(agents|commands)\/[^/]+\.md$/.test(f) ||
      /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f),
  );
  for (const file of candidates) {
    // A command's name comes from its filename, not its frontmatter — only
    // agents and skills declare `name` explicitly.
    const needsName = !/^\.claude\/commands\//.test(file);
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) {
      findings.push({ file, line: 1, message: 'missing YAML frontmatter' });
      continue;
    }
    const body = fm[1];
    if (needsName && !/^name:/m.test(body)) {
      findings.push({ file, line: 1, message: 'frontmatter missing `name`' });
    }
    if (!/^description:/m.test(body)) {
      findings.push({
        file,
        line: 1,
        message: 'frontmatter missing `description`',
      });
    }
  }
  return findings;
}

// ---------- 3. Long "decision-shaped" comment blocks ----------
const LINE_COMMENT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.cs',
  '.rs',
  '.swift',
  '.kt',
]);
const HASH_COMMENT_EXT = new Set(['.py', '.rb', '.sh', '.yml', '.yaml']);
const DASH_COMMENT_EXT = new Set(['.sql']);
const THRESHOLD = 20;
const DECISION_SIGNAL = /\bWHY\b|─{3,}/;

function markerFor(file) {
  const ext = /\.[^./]+$/.exec(file)?.[0];
  if (!ext) return null;
  if (LINE_COMMENT_EXT.has(ext)) return 'line';
  if (HASH_COMMENT_EXT.has(ext)) return 'hash';
  if (DASH_COMMENT_EXT.has(ext)) return 'dash';
  return null;
}

function isCommentLine(trimmed, kind) {
  if (kind === 'line') {
    return (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    );
  }
  if (kind === 'hash') return trimmed.startsWith('#');
  if (kind === 'dash') return trimmed.startsWith('--');
  return false;
}

function scanLongComments(tracked) {
  const findings = [];
  for (const file of tracked) {
    if (/\.(spec|test)\.[^.]+$/.test(file)) continue;
    const kind = markerFor(file);
    if (!kind) continue;
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
    let run = 0;
    let start = 0;
    let text = [];
    const flush = () => {
      if (run >= THRESHOLD && DECISION_SIGNAL.test(text.join('\n'))) {
        findings.push({
          file,
          line: start,
          endLine: start + run - 1,
          length: run,
        });
      }
      run = 0;
      text = [];
    };
    lines.forEach((raw, i) => {
      const trimmed = raw.trim();
      if (isCommentLine(trimmed, kind)) {
        if (run === 0) start = i + 1;
        run++;
        text.push(trimmed);
      } else {
        flush();
      }
    });
    flush();
  }
  return findings;
}

// ---------- 4. Optional: config-driven doc-vs-code list sync ----------
function backtickedNear(filePath, marker) {
  const text = readFileSync(join(REPO_ROOT, filePath), 'utf8');
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const rest = text.slice(idx + marker.length);
  const nextHeading = rest.search(/\n#{1,6} /);
  const scope = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return new Set([...scope.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
}

function exportedSymbols(filePath) {
  const text = readFileSync(join(REPO_ROOT, filePath), 'utf8');
  return new Set(
    [...text.matchAll(/^export (?:function|const|class)\s+([A-Za-z0-9_]+)/gm)].map(
      (m) => m[1],
    ),
  );
}

function intColumnsMatching(filePath, namePattern) {
  const text = readFileSync(join(REPO_ROOT, filePath), 'utf8');
  const out = new Set();
  for (const model of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = model;
    for (const field of body.matchAll(/^\s*(\w+)\s+Int\??\b/gm)) {
      if (namePattern.test(field[1])) out.add(`${name}.${field[1]}`);
    }
  }
  return out;
}

const EXTRACTORS = {
  'backticked-near': backtickedNear,
  'exported-symbols': exportedSymbols,
  'int-columns-matching': intColumnsMatching,
};

async function checkWatches() {
  const configPath = join(SKILL_DIR, 'watches.config.mjs');
  if (!existsSync(configPath)) return [];
  const { watches } = await import(pathToFileURL(configPath).href);
  const findings = [];
  for (const w of watches) {
    const docExtract = EXTRACTORS[w.doc.extract];
    const codeExtract = EXTRACTORS[w.code.extract];
    const docSet = docExtract(w.doc.file, w.doc.marker ?? w.doc.pattern);
    const codeSet = codeExtract(w.code.file, w.code.pattern ?? w.code.marker);
    if (!docSet || !codeSet) continue;
    for (const item of codeSet) {
      if (!docSet.has(item)) {
        findings.push({
          file: w.doc.file,
          line: null,
          message: `[${w.name}] \`${item}\` exists in ${w.code.file} but is not documented`,
        });
      }
    }
  }
  return findings;
}

// ---------- run ----------
const tracked = trackedFiles();
const citations = checkCitations(tracked);
const claudeFiles = checkClaudeFiles(tracked);
const longComments = scanLongComments(tracked);
const watchFindings = await checkWatches();

function section(title, items, formatter) {
  console.log(`\n## ${title} (${items.length})`);
  for (const it of items) console.log(formatter(it));
}

section('Dangling doc citations', citations, (f) => `${f.file}:${f.line}: ${f.message}`);
section('.claude/** structural gaps', claudeFiles, (f) => `${f.file}:${f.line}: ${f.message}`);
section(
  'Long comment blocks (verify against the domain-modeling ADR test before acting)',
  longComments,
  (f) => `${f.file}:${f.line}-${f.endLine} (${f.length} lines)`,
);
section('Doc-vs-code list drift', watchFindings, (f) => `${f.file}: ${f.message}`);

const total =
  citations.length + claudeFiles.length + longComments.length + watchFindings.length;
console.log(`\n${total} finding(s) across 4 categories.`);
process.exitCode = total > 0 ? 1 : 0;
