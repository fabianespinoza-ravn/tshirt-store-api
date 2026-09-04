import { HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CartController } from './cart.controller';
import type { CartService } from './cart.service';

const client: AuthenticatedUser = {
  id: 'client-1',
  email: 'client@example.test',
  role: UserRole.CLIENT,
};

describe('CartController', () => {
  const cart = { items: [], subtotal: 0 };
  const service = {
    getCart: jest.fn(),
    addItem: jest.fn(),
    updateItem: jest.fn(),
    removeItem: jest.fn(),
  };
  const controller = new CartController(service as unknown as CartService);

  beforeEach(() => jest.clearAllMocks());

  it('returns the caller cart from the service', async () => {
    service.getCart.mockResolvedValue(cart);

    await expect(controller.getCart(client)).resolves.toEqual(cart);
    expect(service.getCart).toHaveBeenCalledWith(client);
  });

  it.each([
    [true, HttpStatus.CREATED],
    [false, HttpStatus.OK],
  ])('maps created %s to HTTP %i', async (created, status) => {
    service.addItem.mockResolvedValue({ cart, created });
    const response = { status: jest.fn() };

    await expect(
      controller.addCartItem(
        client,
        { skuId: 'sku-1', quantity: 2 },
        response as never,
      ),
    ).resolves.toEqual(cart);
    expect(service.addItem).toHaveBeenCalledWith(client, 'sku-1', 2);
    expect(response.status).toHaveBeenCalledWith(status);
  });

  it('delegates update and removal with the caller-owned line id', async () => {
    service.updateItem.mockResolvedValue(cart);
    service.removeItem.mockResolvedValue(cart);

    await expect(
      controller.updateCartItem(client, 'line-1', { quantity: 3 }),
    ).resolves.toEqual(cart);
    await expect(controller.removeCartItem(client, 'line-1')).resolves.toEqual(
      cart,
    );
    expect(service.updateItem).toHaveBeenCalledWith(client, 'line-1', 3);
    expect(service.removeItem).toHaveBeenCalledWith(client, 'line-1');
  });
});
