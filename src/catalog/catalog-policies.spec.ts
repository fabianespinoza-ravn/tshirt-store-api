import { CHECK_POLICIES_KEY } from '../auth/casl/check-policies.decorator';
import { CatalogController } from './catalog.controller';

describe('CatalogController policies', () => {
  it.each([
    ['createProduct', 'create', 'Product'],
    ['updateProduct', 'update', 'Product'],
    ['deleteProduct', 'delete', 'Product'],
    ['uploadImage', 'create', 'ProductImage'],
    ['deleteImage', 'delete', 'ProductImage'],
    ['createSku', 'create', 'Sku'],
    ['updateSku', 'update', 'Sku'],
  ])('declares %s as %s on %s', (method, action, subject) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      CatalogController.prototype,
      method,
    );

    const handler: unknown = descriptor?.value;
    expect(typeof handler).toBe('function');
    if (typeof handler !== 'function') {
      throw new Error(`Catalog handler ${method} is missing.`);
    }

    expect(Reflect.getMetadata(CHECK_POLICIES_KEY, handler as object)).toEqual([
      { action, subject },
    ]);
  });
});
