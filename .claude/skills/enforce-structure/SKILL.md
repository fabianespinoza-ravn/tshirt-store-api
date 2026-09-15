---
name: enforce-structure
description: >-
  Checks a repo's folders against a declared layout, and can move the ones
  that don't conform. Use when a folder's kind isn't obvious from where it
  sits — a folder that looks like a feature module but holds no module file,
  a shared folder that grew one, a source file left loose at the root; when
  onboarding a repo whose top level doesn't say what each folder is; or
  before adding a folder, to know where it belongs. Reports violations by
  default; with `--apply` it moves folders and rewrites every import the
  move breaks. Edits files, not read-only.
---

# Enforce structure

A repo's top level should say what each folder *is*. This checks that claim
against a layout declared in `layout.config.mjs`, and can migrate what
disagrees.

It does not have an opinion about which layout is right — that's an
architecture decision, and it belongs to the author. It enforces the one the
repo declared.

## Steps

1. **Check.** From the repo root: `node .claude/skills/enforce-structure/structure.mjs`.
   Done when you have the violation list (exit 1 means violations, 0 means
   the layout holds).

2. **Decide, per violation.** Two kinds, and only one of them is a move:
   - *Folder in the wrong tier* — mechanical, `--apply` handles it.
   - *Stray root file, or a module found inside the shared tier* — these
     need a human call about what the thing actually is. Say so; don't guess
     a destination for it.

3. **Before applying, make a restore point.** The migration rewrites imports
   across the repo. Ask the author to commit or stash first — if the result
   is wrong, a clean restore point is the difference between `git checkout`
   and untangling a half-moved tree by hand.

4. **Apply.** `node .claude/skills/enforce-structure/structure.mjs --apply`.
   It moves the folders and recomputes every relative import: resolve each
   specifier against the file's old location, map it through the moves,
   recompute from the new location.

5. **Verify with the repo's full CI sequence — this step is the point.** In
   this repo that is `/preflight`; in another, run whatever its CI runs.
   Type checking, tests and build are not enough on their own, and this is
   not a hypothetical: on the first real migration all three passed green
   while `lint:ci` failed with nine errors.
   - A **path glob that stops matching turns a rule off** rather than
     failing — an `ignores: ['src/common/**']` that no longer matches means
     the rule it exempted now fires on files it was written to spare.
   - A **lengthened specifier can outgrow the formatter's line width**, so
     `format:check` fails on a line nobody edited. Run the repo's formatter
     (`npm run format` here) and re-run the sequence; the script does the
     semantic rewrite and leaves formatting to whatever the repo already
     uses for it.

   Report success only with the whole sequence green. If type checking
   fails, read it before touching anything: the failures name the exact
   specifiers computed wrong, and it is usually one pattern repeated rather
   than dozens of separate problems. Fix the script, not the output — a
   hand-patched import hides a bug that ships.

6. **Re-check.** Run the checker again; the violations it moved should be
   gone. Then run `audit-repo-docs`: a move breaks documentation that cites
   the old paths, and that check is what finds those.

   **Stage the move before auditing.** Until it is staged, `git ls-files`
   still reports the old paths, so every new path reads as untracked and the
   audit mixes real stale citations with that artefact. Staging first makes
   the list say only what actually broke.

## Extending to another repo

`structure.mjs` is repo-agnostic — copy it as-is. `layout.config.mjs` is the
part that changes: declare the tiers, what each requires, and which files may
sit at the root. A repo with a different shape (a `packages/` monorepo, a
`cmd/` + `internal/` Go layout) declares that instead; the checker's question
is always the same one — does this folder's location match its kind?
