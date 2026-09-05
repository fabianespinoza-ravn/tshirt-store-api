/**
 * Matches an array holding exactly these members, in any order.
 *
 * `expect.arrayContaining` admits **extras**, and for an authorization scope
 * that is the difference between a test and a decoration: the courier's rules
 * produce `{ OR: [...] }`, that array goes into a Prisma `where`, and a third
 * rule granting `{ status: PAID }` would widen a courier's reach to every paid
 * order in the table while every `arrayContaining` assertion still passed.
 * Verified before this existed — adding that rule left all 164 tests green.
 *
 * Order is deliberately not pinned. CASL decides the order of the `OR` array
 * from the order the rules were declared in, and swapping two `can(...)` calls
 * changes nothing about who can reach what. A test that failed on it would be
 * reporting a rearrangement as a security change.
 *
 * The members are compared by their serialised form, which is sound here
 * because a scope predicate is a flat object of primitives. It would not be
 * sound for anything holding a Date, a RegExp or a key whose order can vary.
 */
export const exactlyTheseInAnyOrder = (expected: unknown[]) => ({
  asymmetricMatch: (actual: unknown): boolean =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((want) =>
      (actual as unknown[]).some(
        (got) => JSON.stringify(got) === JSON.stringify(want),
      ),
    ),
  toString: (): string => `ExactlyTheseInAnyOrder(${JSON.stringify(expected)})`,
});
