---
name: authorized-resource
description: Use when adding a new resource that needs a CASL policy in this codebase — e.g. Week 4's cart, orders, payment links, and promo codes. Packages the DTO → CASL rule → service → controller → verification sequence this repo already follows for catalog resources; it is a checklist, not a restatement of the conventions themselves.
---

# Adding an authorized resource

This is the sequence the catalog module (`Category`, `Product`, `Sku`, ...)
already follows. It's a pointer, not a copy — the actual rules live in
`CLAUDE.md` and `docs/AUTHORIZATION-MATRIX.md`; read those before starting,
not this file for the details.

1. **DTO.** `class-validator`-decorated request/response shapes, next to the
   resource (see `src/categories/dto/*.dto.ts` for the shape).

2. **CASL rule**, in `src/auth/casl/app-ability.factory.ts`. Add the subject
   to `AppSubjectName` / `AppSubjects` if it's new. Look up the resource's row
   in `docs/AUTHORIZATION-MATRIX.md` first: if the matrix marks it
   CLIENT-owned (cart, orders, ...), the rule needs an owner condition — and
   remember `PoliciesGuard` only enforces unconditional rules, so an owner
   condition only does anything once the service applies it (see step 3).

3. **Service**, with tests. Row-level scoping happens here: fold the CASL
   condition into the Prisma call (`accessibleBy(ability, action).ofType(...)`
   or an equivalent explicit `where`), never in the guard. Tests assert on
   the Prisma call the code makes — `expect(prisma.x.y).toHaveBeenCalledWith(...)`
   — per `CLAUDE.md`, not on what the mock returns.

4. **Controller**, with `@CheckPolicies({ action, subject })` wiring the
   route to the ability. This only gates by role — see step 2.

5. **Authorization check.** Hand the diff to the `casl-guard` agent: it
   checks the CASL rule and the service's Prisma call against
   `docs/AUTHORIZATION-MATRIX.md` and answers whether a CLIENT can reach
   another user's row through it.

6. **Verify.** Run `/preflight` before considering the change done.
