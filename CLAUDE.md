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
- Coverage cannot drop below the thresholds in `package.json`'s `jest.coverageThreshold`
  (statements 75, branches 65, functions 63, lines 74). Raise the floor when
  coverage improves; never lower it to make a PR pass.

## Other conventions

- `src/common/filters/problem-details.filter.ts` is the only place an error
  response is shaped; no other code formats one.
- Run `/preflight` before considering a change done.
- The user's global `pre-commit` hook should run `npm run precommit --if-present`
  from the repository root.
