---
name: audit-repo-docs
description: >-
  Read-only documentation and comment auditor for any repo. Use after moving
  or renaming anything documentation might name; before opening a PR that
  touches Markdown docs, `.claude/skills`, `.claude/agents`, or
  `.claude/commands`; after adding, renaming, or removing an exported symbol,
  config value, or schema column that a README or doc table enumerates; or
  when a source comment has grown into a multi-paragraph rationale that reads
  like an architectural decision. Reports paths that resolve to nothing —
  documents, source files and directories alike — incomplete `.claude/**`
  files, drifted doc-vs-code lists, and ADR-worthy comment blocks. Does not
  edit anything, only reports.
---

# Audit repo docs

Finds where a repo's documentation, `.claude/**` files, or source comments
have drifted from what the repo actually does. Reports findings; never edits
— that's `sync-docs`'s job.

## Steps

1. **Run the audit.** From the repo root: `node .claude/skills/audit-repo-docs/audit.mjs`.
   Done when you have its four-section report (exit code 1 means at least one
   finding; 0 means clean). If Node isn't available in this environment, say
   so — don't approximate the mechanical checks by eye.

2. **Filter the long-comment section.** Everything else in the report is
   mechanical and correct as-is. This section is not: it only flags length +
   a "WHY"/divider signal, which is a cheap proxy for "might be a decision,"
   not proof. For each flagged range, read it and apply the three-part test
   from **domain-modeling** (hard to reverse, surprising without context, the
   result of a real trade-off) — all three, not two. Drop any block that
   fails even one; a long comment that's merely a long explanation of *what*
   the code does is not a finding here.

3. **Report.** For each surviving finding, give `file:line` and a one-line
   reason a reader can act on without re-reading the source:
   - Dangling citation → what it cites and that the target isn't tracked.
   - `.claude/**` gap → which frontmatter field is missing.
   - Comment block → the proposed ADR title (one sentence) and why it passed
     all three domain-modeling tests, not just that it's long.
   - List drift → the name and which side (doc or code) is missing it.

   If a category has zero findings, omit it — don't pad the report with
   confirmations. If `watches.config.mjs` doesn't exist next to the script,
   that layer is skipped by design, not a failure to mention.

## Extending to another repo

The script needs no repo-specific setup for citations, `.claude/**`
structure, or comment scanning — copy `audit.mjs` as-is. The list-drift layer
is the one part that's inherently repo-specific (it has to know *which*
doc list should mirror *which* code); add entries to `watches.config.mjs`
only if that layer is wanted. An empty or missing config just skips it.
