---
name: enforce-structure
description: >-
  Checks a repo's folders against a declared layout, and can move the ones
  that don't conform. Use when the top level lists everything flat so nothing
  says which folders belong together; when a folder sits outside the domain
  it belongs to, or inside one without being a module; when a source file is
  left loose at a root that declares its entry points; or before adding a
  folder, to know where it goes. Reports violations by default; with
  `--apply` it moves folders and rewrites every import and path string the
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

2. **Decide, per violation.** Only one kind is a move:
   - *Declared somewhere it isn't yet* (`move-to-domain`) — the config says
     where it goes, so `--apply` handles it mechanically.
   - *Loose file in a domain, a folder inside a domain with no module, a
     folder that is neither a module nor a folder of modules, a stray file
     at the root* — each needs a human call about what the thing actually
     is. Report them; don't guess a destination.

   Membership is the part the checker cannot derive: nothing about a `cart/`
   folder says it belongs to checkout. That decision lives in
   `layout.config.mjs`, and the check reports whatever hasn't arrived there.
   Shape — a domain is a module or a folder of modules, with an optional
   `shared/` of its own — is derived, so it keeps holding for folders added
   later without touching the config.

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
     failing — an obsolete ignore glob means the rule it exempted now fires
     on files it was written to spare.
   - A **lengthened specifier can outgrow the formatter's line width**, so
     `format:check` fails on a line nobody edited. Run the repo's formatter
     (`npm run format` here) and re-run the sequence; the script does the
     semantic rewrite and leaves formatting to whatever the repo already
     uses for it.
   - A **moved file can leave the test runner's cache stale**, and the crash
     that follows carries no message: the suite exits non-zero having printed
     nothing at all. Re-run with the cache off (`--no-cache` for jest) before
     reading anything into a failure that appeared right after a move.
   - After `--alias`, **grep the build output** for the alias prefix:
     `grep -rl 'require("@' dist/` must print nothing. Whether aliases
     survive compilation depends on the builder, and the build reports
     success either way.

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
part that changes: the root, the files allowed loose in it, the reserved
folder names, and which members belong to which domain. A repo with a
different shape (a `packages/` monorepo, a `cmd/` + `internal/` Go layout)
declares that instead; the checker's question is always the same one — does
this folder's location match its kind?

Declare membership only for what still has to move. Once a domain is
assembled, its entry can stay as the record of what belongs to it, or go:
the shape rules keep holding either way, which is what makes the tool
useful on the run after the migration rather than only during it.
