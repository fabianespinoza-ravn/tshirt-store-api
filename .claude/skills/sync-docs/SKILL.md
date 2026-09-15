---
name: sync-docs
description: >-
  Applies fixes found by audit-repo-docs. Use after that audit reports
  dangling doc references, drifted doc-vs-code lists, incomplete
  `.claude/skills|agents|commands` files, or a comment block flagged as
  ADR-worthy. Updates the affected README/CLAUDE.md tables, creates and
  fills any missing referenced file, and extracts a flagged comment into a
  new `docs/adr/NNNN-slug.md`, replacing it with a short rationale and
  pointer. Re-runs the audit to confirm the fix. Edits files, not read-only.
---

# Sync docs

Applies what `audit-repo-docs` found. One fix pattern per finding category —
never guess at a category that audit didn't report.

**REQUIRED SUB-SKILL:** domain-modeling — for the ADR template and numbering.

## Steps

1. **Get findings.** Run `audit-repo-docs` if you don't already have a
   current report. Work from what it actually found, not from memory of a
   previous run — the repo may have changed since.

2. **Fix each category:**
   - **Dangling citation.** Read the citing sentence to decide which side is
     wrong: if the doc clearly describes content that should exist (a
     skill, an agent, a convention doc), create that file and fill it with
     real content matching what the citing text implies — not a stub. If the
     citation is simply wrong (renamed/removed target), fix or drop the
     citation instead.
   - **`.claude/**` structural gap.** Add the missing frontmatter field with
     real content inferred from the file's body — never a placeholder like
     `TODO` or `description: ...`.
   - **List drift.** Add the missing entries to the doc's existing
     table/list, matching its current formatting exactly (same style,
     alphabetical or grouping order if one is already in use).
   - **ADR-worthy comment.** Scan `docs/adr/` for the highest existing
     number (00 if the directory doesn't exist yet) and create
     `docs/adr/<next-number>-<slug>.md` using domain-modeling's ADR
     template — title plus 1-3 sentences (context, decision, why); add
     "Considered Options" only if the source comment already names a
     rejected alternative explicitly. Then shrink the original comment to a
     short WHY plus a pointer to the new ADR path — don't delete the WHY
     entirely, the reader still needs it without opening another file.

3. **Re-verify.** Run `audit-repo-docs` again. Done when the categories you
   touched report zero findings. If you deliberately left something
   unfixed (out of scope for this change), say so explicitly in your
   report — don't let it silently disappear.

   **A new file you just created will still show as a dangling citation.**
   `audit-repo-docs`'s citation check only counts `git`-tracked files, and a
   file you created in this step isn't tracked until it's staged. That's the
   checker working correctly, not a failed fix — a citation to an untracked
   file really would resolve to nothing on a fresh clone. Note it in your
   report as "resolves once staged," don't try to make it disappear by
   staging or committing yourself.

4. **Report the diff.** List each file touched and what changed, plus the
   finding count before and after. That before/after pair is the evidence
   this change actually did something.
