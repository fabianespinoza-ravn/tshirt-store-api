import { CHECK_POLICIES_KEY } from '../auth/casl/check-policies.decorator';
import { CategoriesController } from './categories.controller';

// This spec only checks the `@CheckPolicies` metadata attached to each
// handler, not authorization behaviour: a guard weakened to allow everyone
// would still pass it.
describe('CategoriesController policies', () => {
  it.each([
    ['createCategory', 'create', 'Category'],
    ['updateCategory', 'update', 'Category'],
    ['deleteCategory', 'delete', 'Category'],
  ])('declares %s as %s on %s', (method, action, subject) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      CategoriesController.prototype,
      method,
    );

    const handler: unknown = descriptor?.value;
    expect(typeof handler).toBe('function');
    if (typeof handler !== 'function') {
      throw new Error(`Categories handler ${method} is missing.`);
    }

    expect(Reflect.getMetadata(CHECK_POLICIES_KEY, handler as object)).toEqual([
      { action, subject },
    ]);
  });
});
