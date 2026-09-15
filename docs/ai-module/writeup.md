# AI Module - Write-Up

**Repository / PR:**
`fabianespinoza-ravn/tshirt-store-api`
Branch: `fabianespinoza-ravn/ai-module-skills`
PR: pending

**Starting commit:**
`910c64c` — `docs(diagrams): improve light-mode legibility (#54)`

**Improvement:**
The repository gained a repeatable structure-and-documentation maintenance
cycle. Source modules were reorganized from 19 flat folders into six meaningful
groups: `auth`, `catalog`, `checkout`, `platform`, `shared`, and `testing`.

Cross-domain imports now name the domain through aliases such as
`@shared/common/ids` and `@catalog/shared/views`. Imports that remain within a
domain intentionally stay relative.

The three skills form one workflow:

1. `enforce-structure` checks or applies the declared layout.
2. `audit-repo-docs` detects documentation and comment drift caused by the
   structural change.
3. `sync-docs` applies reviewed findings and sends every write back through the
   audit.

The result is enforced mechanically by the repository checks and was validated
through type checking, linting, formatting, compilation, unit tests, E2E tests,
and inspection of the emitted JavaScript.

## Skills

| Skill (file link)                                                      | Goal, inputs → steps → output                                                                                                                                                                                                                                                                | Exact invocation                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`enforce-structure`](../../.claude/skills/enforce-structure/SKILL.md) | Reads the declared layout from [`layout.config.mjs`](../../.claude/skills/enforce-structure/layout.config.mjs), reports structural violations, and optionally moves folders while rewriting affected imports and path strings. Produces either a violation report or a migrated source tree. | Check: `node .claude/skills/enforce-structure/structure.mjs`<br>Apply: `node .claude/skills/enforce-structure/structure.mjs --apply` |
| [`audit-repo-docs`](../../.claude/skills/audit-repo-docs/SKILL.md)     | Reads tracked files, documentation, `.claude/**`, source comments, and configured doc-vs-code lists. Reports dangling citations, incomplete Claude artifacts, possible ADR candidates, and list drift. It never edits files.                                                                 | `node .claude/skills/audit-repo-docs/audit.mjs`                                                                                      |
| [`sync-docs`](../../.claude/skills/sync-docs/SKILL.md)                 | Consumes a current audit report, fixes verified documentation drift, completes missing metadata, updates mirrored lists, and extracts genuine architectural decisions into ADRs. It then reruns the audit and reports the before/after counts.                                               | Invoke `/sync-docs` after obtaining a current audit report.                                                                          |

**Notes:**
The scripts reuse Git's tracked-file list, the repository's existing formatter,
TypeScript and Jest configuration, and the `domain-modeling` ADR criteria.

`enforce-structure --apply` requires a clean commit or stash before execution
because it can move and rewrite many files. The migration can be rolled back
through Git; it does not modify production data or contact external services.

## Project Results

**Before → after:**

- `src/` changed from 19 flat module folders to six meaningful groups.
- Cross-domain dependencies changed from long relative paths to explicit domain
  aliases.
- Imports that stay within a domain remain relative.
- The first structural migration broke nine documentation citations.
- `audit-repo-docs` found all nine, including seven references to `.ts` files
  that the repository's original Markdown-only checker could not detect.
- `sync-docs` corrected every stale citation. Historical migration failures are
  described without citation-shaped obsolete paths.
- Four buried architectural decisions were extracted into [`docs/adr/`](../adr/).
- Structural enforcement, documentation auditing, and synchronization now form
  one repeatable feedback cycle instead of three unrelated tools.

Human judgment was still required for:

- Declaring which modules belong to each domain.
- Deciding whether a dangling path is stale or intentionally historical.
- Applying the three-part `domain-modeling` test to long comments.
- Reviewing whether an explanation represents a real architectural trade-off.

**Evidence:**

Final structural check:

```text
$ node .claude/skills/enforce-structure/structure.mjs
enforce-structure: src/ matches the declared layout.
exit=0
```

Final documentation audit:

```text
audit-repo-docs: no findings across 4 categories.
```

Final repository verification:

```text
Type checking             passed
Lint and citation checks  passed
Formatting                passed
Production build          passed
Unit tests                872/872 passed
E2E tests                 117/117 passed
Unresolved dist aliases   0
```

The E2E tests use the real Nest application, worker, PostgreSQL database, Redis
queues, processors, and Prisma access. Stripe, outbound mail, throttler storage,
and the recurring sweep scheduler are replaced with controlled test
implementations.

Organized commits:

```text
feat(skills): add audit-repo-docs and sync-docs
docs: extract buried architecture decisions into ADRs
feat(skills): add enforce-structure
refactor(structure): organize source modules by domain
refactor(imports): use aliases across domain boundaries
docs(skills): document the final maintenance workflow
```

**Limitations:**

- ADR classification showed variation between independent reviews: two fresh
  runs disagreed on two of five candidates. Human review is recommended before
  merge.
- The branch has no upstream and no PR has been opened yet.
