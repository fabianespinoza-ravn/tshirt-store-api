# tshirt-store-api

NestJS + Prisma REST API. These are the constraints that hold across the
codebase; see `docs/ARQUITECTURA.md` for the production architecture and
`docs/AUTHORIZATION-MATRIX.md` for the authorization contract.

## Style

- English for all code and comments. No exceptions, including new files
  under `src/` and `test/`.
- Conventional Commits for every commit message.
- Enum members instead of string literals for anything that has one —
  order status, role, node environment, and the rest of
  `src/**/*.ts` enums. A string literal that duplicates an enum value is a
  finding, not a style nit.

## Tests

- Assert on the Prisma call the code under test makes — `expect(prisma.x.y)
.toHaveBeenCalledWith(...)` — not on what the mock returns. The mock's
  return value only proves the test wired a fixture; the Prisma call proves
  the code asked the database for the right thing.
- Coverage cannot drop below `package.json`'s `jest.coverageThreshold`. Raise
  the floor when coverage improves; never lower it to make a PR pass.
  `lint:ci` runs `check:coverage-floor`, which compares the floor against
  main and fails when a metric goes down or disappears, so the rule no longer
  depends on anyone remembering it.
- Assertions for behaviour the assistant generated are the student's to
  write. The assistant scaffolds the harness, the fixtures and `it.todo`
  stubs that name each case, never the `expect` calls for code it wrote: a
  generated assertion would assert the behaviour it produced, bugs included.
  A stub is a declared gap, and the PR that carries it is not done until the
  student has replaced it.

## Other conventions

- `src/common/filters/problem-details.filter.ts` is the only place an error
  response is shaped; no other code formats one.
- Run `/preflight` before considering a change done.
- `core.hooksPath` points outside the repo, at `~/.claude/git-hooks`: its
  `pre-commit` runs `npm run precommit --if-present` (lint-staged), and a
  hook committed here would be shadowed by it.
- Root-level `*.md` files other than `README.md` and `CLAUDE.md` are
  untracked local notes; never cite one from a tracked file. `lint:ci` fails
  on a citation of an untracked Markdown file.
- Money is an integer number of cents everywhere — `Sku.price`, `Order.total`,
  `OrderItem.unitPrice`, `Payment.amount`. Nothing rounds, so ESLint rejects
  `toFixed` and `parseFloat`, and `no-console` under `src/` keeps output in
  the logger rather than on stdout.
- A credential-shaped string cannot be written into the repository: the
  `deny-secret-literals` hook denies the write, whatever the file. A test
  that needs a key reads it from the environment.
