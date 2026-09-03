import { CHECK_POLICIES_KEY } from '../auth/casl/check-policies.decorator';
import { ImagesController } from './images.controller';

// This spec only checks the `@CheckPolicies` metadata attached to each
// handler, not authorization behaviour: a guard weakened to allow everyone
// would still pass it.
describe('ImagesController policies', () => {
  it.each([
    ['uploadImage', 'create', 'ProductImage'],
    ['deleteImage', 'delete', 'ProductImage'],
  ])('declares %s as %s on %s', (method, action, subject) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      ImagesController.prototype,
      method,
    );

    const handler: unknown = descriptor?.value;
    expect(typeof handler).toBe('function');
    if (typeof handler !== 'function') {
      throw new Error(`Images handler ${method} is missing.`);
    }

    expect(Reflect.getMetadata(CHECK_POLICIES_KEY, handler as object)).toEqual([
      { action, subject },
    ]);
  });
});
