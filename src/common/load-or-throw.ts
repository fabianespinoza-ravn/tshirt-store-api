import { Problems, type ProblemKind } from './problem/problem.catalog';
import { ProblemException } from './problem/problem.exception';

// The one "fetch a row or fail with a Problem" idiom, replacing three that had
// drifted apart: ProductsService.loadForManager returned the row, CategoriesService
// mustExist discarded it and forced callers to refetch, and AuthService inlined
// the check with no helper at all. `isValid` lets a caller add a business rule
// beyond mere existence (a consumed or expired token) while still reporting one
// Problem for every way the row can fail to be usable.
export async function loadOrThrow<T>(
  find: () => Promise<T | null>,
  detail: string,
  kind: ProblemKind = Problems.notFound,
  isValid: (row: T) => boolean = () => true,
): Promise<T> {
  const row = await find();
  if (!row || !isValid(row)) throw new ProblemException(kind, detail);
  return row;
}
