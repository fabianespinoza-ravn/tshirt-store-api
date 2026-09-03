import { CHECK_POLICIES_KEY } from '../auth/casl/check-policies.decorator';
import { ProductsController } from './products.controller';

// This spec only checks the `@CheckPolicies` metadata attached to each
// handler, not authorization behaviour: a guard weakened to allow everyone
// would still pass it.
describe('ProductsController policies', () => {
  it.each([
    ['createProduct', 'create', 'Product'],
    ['updateProduct', 'update', 'Product'],
    ['deleteProduct', 'delete', 'Product'],
  ])('declares %s as %s on %s', (method, action, subject) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      ProductsController.prototype,
      method,
    );

    const handler: unknown = descriptor?.value;
    expect(typeof handler).toBe('function');
    if (typeof handler !== 'function') {
      throw new Error(`Products handler ${method} is missing.`);
    }

    expect(Reflect.getMetadata(CHECK_POLICIES_KEY, handler as object)).toEqual([
      { action, subject },
    ]);
  });
});
