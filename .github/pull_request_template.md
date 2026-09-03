## What this changes

<!-- One paragraph. What the reviewer will see in the diff, and why. -->

## Why

<!-- The decision behind it. Link the plan or the ERD section if there is one. -->

## Checklist

- [ ] `npm run typecheck`, `npm run lint:ci` and `npm run format:check` pass
- [ ] `npm test` passes, and new behaviour arrived with its own test
- [ ] No secret, token or connection string in the diff — `.env` stays untracked
- [ ] Authorization changes are reflected in the authorization matrix
- [ ] Prisma schema changes were applied with `npm run prisma:sync` against a local database, not just typed into `schema.prisma`
- [ ] Public API changes are reflected in the OpenAPI decorators
- [ ] `README.md` and `docs/` still describe what this diff changes: layout, scripts, env vars

## How it was verified

<!-- The commands actually run, or the requests actually made. Not "it should work". -->
