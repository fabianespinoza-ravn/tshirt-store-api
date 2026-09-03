import { CartStatus, UserRole } from '@prisma/client';
import { AppAbilityFactory } from '../auth/casl/app-ability.factory';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Problems } from '../common/problem/problem.catalog';
import { buildService, type ServiceHarness } from '../testing/build-service';
import {
  aCart,
  aCartItem,
  anImage,
  aProduct,
  aSku,
} from '../testing/factories';
import { resetPrismaMock } from '../testing/prisma.mock';
import { CartService } from './cart.service';
import type { CartLineRow } from './cart.views';

/**
 * Harness only: the cases below name one branch of the service each, and
 * the assertions are the student's (CLAUDE.md, Tests).
 *
 * Two of them decide whether this module is safe, so they are worth more
 * than the rest put together. Since `PoliciesGuard` stopped rejecting a
 * conditional rule, the only thing keeping one client out of another's cart
 * is the scope this service folds into its Prisma `where`. Assert the
 * `where` itself — `expect(h.prisma.cart.findFirst).toHaveBeenCalledWith(...)`
 * — and not merely that a Problem was thrown: a service that dropped the
 * scope would still throw for a missing row while happily returning
 * somebody else's.
 *
 * The ability is the real one, so until the CLIENT rules exist every scope
 * here is `{ OR: [] }`. That is itself worth one case.
 */
describe('CartService', () => {
  let h: ServiceHarness<CartService>;

  const client: AuthenticatedUser = {
    id: 'client-1',
    email: 'client@example.test',
    role: UserRole.CLIENT,
  };

  const manager: AuthenticatedUser = {
    id: 'manager-1',
    email: 'manager@example.test',
    role: UserRole.MANAGER,
  };

  const lineFor = (
    cartId: string,
    overrides: { quantity?: number; stock?: number; reserved?: number } = {},
  ): CartLineRow => {
    const product = aProduct();
    const sku = aSku(product.id, overrides);
    return {
      ...aCartItem(cartId, sku.id, { quantity: overrides.quantity ?? 1 }),
      sku: { ...sku, image: null, product },
    };
  };

  const cartWith = (cart = aCart(client.id), items: CartLineRow[] = []) =>
    ({ ...cart, items }) as never;

  beforeEach(async () => {
    h = await buildService(CartService, [AppAbilityFactory]);
    resetPrismaMock(h.prisma);
  });

  describe('getCart', () => {
    it('scopes the lookup with the ability and the ACTIVE status', async () => {
      h.prisma.cart.findFirst.mockResolvedValue(null);

      await h.service.getCart(client);

      const [lookup] = h.prisma.cart.findFirst.mock.calls;
      if (!lookup) throw new Error('getCart did not query carts');
      const [query] = lookup;
      if (!query) throw new Error('getCart query was empty');
      expect(query.where).toEqual({
        AND: [{ OR: [{ userId: client.id }] }, { status: CartStatus.ACTIVE }],
      });
    });

    it('returns an empty cart instead of 404 when none was created yet', async () => {
      h.prisma.cart.findFirst.mockResolvedValue(null);

      await expect(h.service.getCart(client)).resolves.toEqual({
        items: [],
        subtotal: 0,
      });
    });

    it('maps every line with its live product name and SKU price', async () => {
      const cart = aCart(client.id);
      const line = lineFor(cart.id, { quantity: 2 });
      h.prisma.cart.findFirst.mockResolvedValue(cartWith(cart, [line]));

      await expect(h.service.getCart(client)).resolves.toMatchObject({
        items: [
          {
            id: line.id,
            productName: line.sku.product.name,
            quantity: 2,
            unitPrice: line.sku.price,
          },
        ],
      });
    });

    it('adds the lines up into the subtotal', async () => {
      const cart = aCart(client.id);
      const first = lineFor(cart.id, { quantity: 2 });
      const second = lineFor(cart.id, { quantity: 3 });
      h.prisma.cart.findFirst.mockResolvedValue(
        cartWith(cart, [first, second]),
      );

      const result = await h.service.getCart(client);

      expect(result.subtotal).toBe(
        first.sku.price * first.quantity + second.sku.price * second.quantity,
      );
    });

    it('resolves a presigned url for a line whose SKU has an image', async () => {
      const cart = aCart(client.id);
      const line = lineFor(cart.id);
      const image = anImage(line.sku.product.id);
      line.sku.image = image;
      h.prisma.cart.findFirst.mockResolvedValue(cartWith(cart, [line]));

      const result = await h.service.getCart(client);

      expect(h.storage.urlFor).toHaveBeenCalledWith(image.s3Key);
      expect(result.items[0].sku.image).toEqual({
        id: image.id,
        url: `https://s3.test/${image.s3Key}?signed`,
      });
    });
  });

  describe('addItem', () => {
    it('returns 404 for a SKU that does not exist', async () => {
      h.prisma.sku.findFirst.mockResolvedValue(null);

      await expect(
        h.service.addItem(client, 'missing-sku', 1),
      ).rejects.toMatchObject({
        kind: Problems.notFound,
      });
      expect(h.prisma.cart.create).not.toHaveBeenCalled();
    });

    it('returns 404 for a SKU whose product was soft-deleted', async () => {
      h.prisma.sku.findFirst.mockResolvedValue(null);

      await expect(
        h.service.addItem(client, 'deleted-sku', 1),
      ).rejects.toMatchObject({
        kind: Problems.notFound,
      });
      expect(h.prisma.sku.findFirst).toHaveBeenCalledWith({
        where: { id: 'deleted-sku', product: { deletedAt: null } },
      });
    });

    it('creates the cart on the first line and mirrors activeUserId', async () => {
      const sku = aSku(aProduct().id);
      const cart = aCart(client.id);
      h.prisma.sku.findFirst.mockResolvedValue(sku);
      h.prisma.cart.create.mockResolvedValue(cart);

      await h.service.addItem(client, sku.id, 1);

      expect(h.prisma.cart.create).toHaveBeenCalledWith({
        data: {
          id: expect.any(String) as string,
          userId: client.id,
          activeUserId: client.id,
          status: CartStatus.ACTIVE,
        },
      });
    });

    it('reuses the active cart on later lines', async () => {
      const sku = aSku(aProduct().id);
      const cart = aCart(client.id);
      h.prisma.sku.findFirst.mockResolvedValue(sku);
      h.prisma.cart.findFirst
        .mockResolvedValueOnce(cart)
        .mockResolvedValueOnce(null);

      await h.service.addItem(client, sku.id, 1);

      expect(h.prisma.cart.create).not.toHaveBeenCalled();
      expect(h.prisma.cartItem.create).toHaveBeenCalledWith({
        data: {
          id: expect.any(String) as string,
          cartId: cart.id,
          skuId: sku.id,
          quantity: 1,
        },
      });
    });

    it('reports created for a SKU that was not in the cart', async () => {
      const sku = aSku(aProduct().id);
      const cart = aCart(client.id);
      h.prisma.sku.findFirst.mockResolvedValue(sku);
      h.prisma.cart.findFirst
        .mockResolvedValueOnce(cart)
        .mockResolvedValueOnce(null);
      h.prisma.cartItem.findUnique.mockResolvedValue(null);

      await expect(h.service.addItem(client, sku.id, 1)).resolves.toMatchObject(
        {
          created: true,
        },
      );
    });

    it('grows the existing line instead of opening a second one', async () => {
      const sku = aSku(aProduct().id);
      const cart = aCart(client.id);
      const item = aCartItem(cart.id, sku.id, { quantity: 2 });
      h.prisma.sku.findFirst.mockResolvedValue(sku);
      h.prisma.cart.findFirst
        .mockResolvedValueOnce(cart)
        .mockResolvedValueOnce(null);
      h.prisma.cartItem.findUnique.mockResolvedValue(item);

      await h.service.addItem(client, sku.id, 3);

      expect(h.prisma.cartItem.update).toHaveBeenCalledWith({
        where: { id: item.id },
        data: { quantity: 5 },
      });
      expect(h.prisma.cartItem.create).not.toHaveBeenCalled();
    });

    it('reports not created when an existing line grew', async () => {
      const sku = aSku(aProduct().id);
      const cart = aCart(client.id);
      h.prisma.sku.findFirst.mockResolvedValue(sku);
      h.prisma.cart.findFirst
        .mockResolvedValueOnce(cart)
        .mockResolvedValueOnce(null);
      h.prisma.cartItem.findUnique.mockResolvedValue(
        aCartItem(cart.id, sku.id),
      );

      await expect(h.service.addItem(client, sku.id, 1)).resolves.toMatchObject(
        {
          created: false,
        },
      );
    });

    it('returns 409 stock-unavailable when the total exceeds availability', async () => {
      const sku = aSku(aProduct().id, { stock: 3, reserved: 1 });
      h.prisma.sku.findFirst.mockResolvedValue(sku);
      h.prisma.cart.findFirst.mockResolvedValue(aCart(client.id));

      await expect(h.service.addItem(client, sku.id, 3)).rejects.toMatchObject({
        kind: Problems.stockUnavailable,
      });
      expect(h.prisma.cartItem.create).not.toHaveBeenCalled();
    });

    it('returns 409 conflict when the total would pass the line cap', async () => {
      const sku = aSku(aProduct().id, { stock: 200 });
      h.prisma.sku.findFirst.mockResolvedValue(sku);
      h.prisma.cart.findFirst.mockResolvedValue(aCart(client.id));

      await expect(
        h.service.addItem(client, sku.id, 100),
      ).rejects.toMatchObject({
        kind: Problems.conflict,
      });
    });

    it('counts the units already in the line towards both limits', async () => {
      const cart = aCart(client.id);
      const scarce = aSku(aProduct().id, { stock: 3, reserved: 0 });
      const capped = aSku(aProduct().id, { stock: 200 });
      h.prisma.sku.findFirst
        .mockResolvedValueOnce(scarce)
        .mockResolvedValueOnce(capped);
      h.prisma.cart.findFirst.mockResolvedValue(cart);
      h.prisma.cartItem.findUnique
        .mockResolvedValueOnce(aCartItem(cart.id, scarce.id, { quantity: 2 }))
        .mockResolvedValueOnce(aCartItem(cart.id, capped.id, { quantity: 98 }));

      await expect(
        h.service.addItem(client, scarce.id, 2),
      ).rejects.toMatchObject({
        kind: Problems.stockUnavailable,
      });
      await expect(
        h.service.addItem(client, capped.id, 2),
      ).rejects.toMatchObject({
        kind: Problems.conflict,
      });
    });
  });

  describe('updateItem', () => {
    it('scopes the line lookup with the ability, so another cart is 404', async () => {
      h.prisma.cartItem.findFirst.mockResolvedValue(null);

      await expect(
        h.service.updateItem(client, 'other-line', 1),
      ).rejects.toMatchObject({
        kind: Problems.notFound,
      });
      const [lookup] = h.prisma.cartItem.findFirst.mock.calls;
      if (!lookup) throw new Error('updateItem did not query cart items');
      const [query] = lookup;
      if (!query) throw new Error('updateItem query was empty');
      expect(query.where).toEqual({
        AND: [
          { OR: [{ cart: { is: { userId: client.id } } }] },
          { id: 'other-line' },
        ],
      });
    });

    it('returns 404 and never 403 for a line that belongs to somebody else', async () => {
      h.prisma.cartItem.findFirst.mockResolvedValue(null);

      await expect(
        h.service.updateItem(client, 'other-line', 1),
      ).rejects.toMatchObject({
        kind: Problems.notFound,
      });
    });

    it('returns 409 when the new quantity exceeds availability', async () => {
      const item = lineFor(aCart(client.id).id, { stock: 2 });
      h.prisma.cartItem.findFirst.mockResolvedValue(item);

      await expect(
        h.service.updateItem(client, item.id, 3),
      ).rejects.toMatchObject({
        kind: Problems.stockUnavailable,
      });
    });

    it('writes the new quantity on the line it loaded', async () => {
      const item = lineFor(aCart(client.id).id, { stock: 10 });
      h.prisma.cartItem.findFirst.mockResolvedValue(item);
      h.prisma.cart.findFirst.mockResolvedValue(null);

      await h.service.updateItem(client, item.id, 4);

      expect(h.prisma.cartItem.update).toHaveBeenCalledWith({
        where: { id: item.id },
        data: { quantity: 4 },
      });
    });

    it('answers with the whole cart after the update', async () => {
      const cart = aCart(client.id);
      const item = lineFor(cart.id, { stock: 10, quantity: 2 });
      h.prisma.cartItem.findFirst.mockResolvedValue(item);
      h.prisma.cart.findFirst.mockResolvedValue(cartWith(cart, [item]));

      await expect(
        h.service.updateItem(client, item.id, 2),
      ).resolves.toMatchObject({
        items: [{ id: item.id, quantity: 2 }],
        subtotal: item.sku.price * item.quantity,
      });
    });
  });

  describe('removeItem', () => {
    it('scopes the line lookup with the ability, so another cart is 404', async () => {
      h.prisma.cartItem.findFirst.mockResolvedValue(null);

      await expect(
        h.service.removeItem(client, 'other-line'),
      ).rejects.toMatchObject({
        kind: Problems.notFound,
      });
      const [lookup] = h.prisma.cartItem.findFirst.mock.calls;
      if (!lookup) throw new Error('removeItem did not query cart items');
      const [query] = lookup;
      if (!query) throw new Error('removeItem query was empty');
      expect(query.where).toEqual({
        AND: [
          { OR: [{ cart: { is: { userId: client.id } } }] },
          { id: 'other-line' },
        ],
      });
    });

    it('deletes the line it loaded and no other', async () => {
      const item = lineFor(aCart(client.id).id);
      h.prisma.cartItem.findFirst.mockResolvedValue(item);
      h.prisma.cart.findFirst.mockResolvedValue(null);

      await h.service.removeItem(client, item.id);

      expect(h.prisma.cartItem.delete).toHaveBeenCalledWith({
        where: { id: item.id },
      });
    });

    it('answers with the whole cart after the removal', async () => {
      const cart = aCart(client.id);
      const removed = lineFor(cart.id);
      const remaining = lineFor(cart.id, { quantity: 2 });
      h.prisma.cartItem.findFirst.mockResolvedValue(removed);
      h.prisma.cart.findFirst.mockResolvedValue(cartWith(cart, [remaining]));

      await expect(
        h.service.removeItem(client, removed.id),
      ).resolves.toMatchObject({
        items: [{ id: remaining.id, quantity: remaining.quantity }],
        subtotal: remaining.sku.price * remaining.quantity,
      });
    });
  });

  describe('without a Cart rule for the caller role', () => {
    it('sends a where that matches no row at all for a manager', async () => {
      h.prisma.cart.findFirst.mockResolvedValue(null);

      await h.service.getCart(manager);

      const [lookup] = h.prisma.cart.findFirst.mock.calls;
      if (!lookup) throw new Error('getCart did not query carts');
      const [query] = lookup;
      if (!query) throw new Error('getCart query was empty');
      expect(query.where).toEqual({
        AND: [{ OR: [] }, { status: CartStatus.ACTIVE }],
      });
    });
  });
});
