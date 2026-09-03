---
description: Run this repo's CI verification steps locally, in order, stopping at the first failure
---

Mirror `.github/workflows/ci.yml` exactly. Run each of the following in order
using the Bash tool, and stop at the first non-zero exit — report which step
failed and its output instead of continuing to the next one:

1. `npm run prisma:generate`
2. `npm run typecheck`
3. `npm run lint:ci`
4. `npm run format:check`
5. `npm test -- --ci --coverage`
6. `npm run build`

Note the two places this deliberately differs from the everyday scripts:
`lint:ci` (not `lint` — CI only checks, it doesn't `--fix`) and
`format:check` (not `format`), and the test run adds `--ci --coverage`.

If every step passes, report success. If a step fails, stop there, show its
output, and do not attempt to fix it unless asked.
