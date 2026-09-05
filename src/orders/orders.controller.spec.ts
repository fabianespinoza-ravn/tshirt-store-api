import { OrderStatus, UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { OrdersController } from './orders.controller';
import type { OrdersService } from './orders.service';

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

const delivery: AuthenticatedUser = {
  id: 'delivery-1',
  email: 'delivery@example.test',
  role: UserRole.DELIVERY,
};

/**
 * The controller has no logic of its own and that is the point: every
 * decision — the row scope, the transition verdict, the transaction — lives
 * in the service, and this layer exists to hand it the caller and the body
 * unchanged.
 *
 * So what is worth asserting is exactly that. That the authenticated user
 * reaches the service rather than an id taken from the path or the body,
 * because a controller that read the owner from a request field would hand
 * an attacker somebody else's orders with the service none the wiser. And
 * that the query object arrives whole, because a filter dropped here is a
 * page that quietly ignores what the client asked for.
 */
describe('OrdersController', () => {
  const order = { id: 'order-1', status: OrderStatus.PENDING };
  const page = { data: [order], meta: { limit: 20, offset: 0, total: 1 } };

  const service = {
    checkout: jest.fn(),
    list: jest.fn(),
    getOne: jest.fn(),
    statusHistory: jest.fn(),
    updateStatus: jest.fn(),
  };
  const controller = new OrdersController(service as unknown as OrdersService);

  const address = {
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Street',
    city: 'London',
    postalCode: 'E1 6AN',
  };

  beforeEach(() => jest.clearAllMocks());

  it('places an order with the authenticated caller and the posted address', async () => {
    service.checkout.mockResolvedValue(order);

    await expect(controller.checkout(client, address)).resolves.toBe(order);
    expect(service.checkout).toHaveBeenCalledWith(client, address);
  });

  it('returns the page the service produced, untouched', async () => {
    service.list.mockResolvedValue(page);

    await expect(
      controller.list(client, { limit: 20, offset: 0 }),
    ).resolves.toBe(page);
  });

  it('passes the whole query object through, so no filter is dropped', async () => {
    const query = {
      status: OrderStatus.PAID,
      placedFrom: '2026-01-01T00:00:00.000Z',
      placedTo: '2026-01-31T00:00:00.000Z',
      minTotal: 100,
      maxTotal: 500,
      limit: 20,
      offset: 40,
    };
    service.list.mockResolvedValue(page);

    await controller.list(client, query);

    expect(service.list).toHaveBeenCalledWith(client, query);
  });

  it('resolves one order by the id in the path, for the caller', async () => {
    service.getOne.mockResolvedValue(order);

    await expect(controller.getOne(client, order.id)).resolves.toBe(order);
    expect(service.getOne).toHaveBeenCalledWith(client, order.id);
  });

  it('sends the destination status from the body, not from the path', async () => {
    const dto = { status: OrderStatus.CANCELLED };
    service.updateStatus.mockResolvedValue(order);

    await controller.updateStatus(client, 'path-order-id', dto);

    expect(service.updateStatus).toHaveBeenCalledWith(
      client,
      'path-order-id',
      OrderStatus.CANCELLED,
    );
  });

  it('never derives the caller from the request body or the path', async () => {
    const dto = { status: OrderStatus.CANCELLED, userId: manager.id };
    service.updateStatus.mockResolvedValue(order);

    await controller.updateStatus(client, manager.id, dto);

    expect(service.updateStatus).toHaveBeenCalledWith(
      client,
      manager.id,
      OrderStatus.CANCELLED,
    );
  });

  /**
   * The status-history route, which adds no logic to this layer either and
   * therefore has exactly one thing worth pinning: that the caller reaching
   * the service is the authenticated one from the token and the id is the one
   * from the path. A controller that read an owner from anywhere else would
   * hand over another buyer's transitions with the service none the wiser,
   * because the service scopes by the user it is given.
   *
   * Stubs, not assertions: the route is the assistant's work, so the
   * `expect` calls belong to the student.
   */
  describe('the status history passthrough', () => {
    it.todo(
      'asks the service for the history of the path id, for the token caller',
    );

    it.todo('returns the entries the service produced, untouched');

    it.todo(
      'never derives the caller from the path, so a client id in the url reads nothing',
    );
  });

  /**
   * The courier changes nothing about this layer, and a passthrough test that
   * proves it is worth having anyway: the temptation with a third role is to branch
   * here — read the destination, decide the scope, shortcut the state
   * machine — and every one of those moves puts an authorization decision
   * somewhere the service cannot see it. Assert the passthrough and the
   * branch has nowhere to hide.
   */
  describe('the DELIVERY passthrough', () => {
    it('hands a courier to list unchanged', async () => {
      const query = { limit: 10, offset: 2 };
      service.list.mockResolvedValue(page);

      await expect(controller.list(delivery, query)).resolves.toBe(page);
      expect(service.list).toHaveBeenCalledWith(delivery, query);
    });

    it('sends DELIVERED from the body with the path id and token courier', async () => {
      const dto = { status: OrderStatus.DELIVERED };
      service.updateStatus.mockResolvedValue(order);

      await controller.updateStatus(delivery, 'shipped-order', dto);

      expect(service.updateStatus).toHaveBeenCalledWith(
        delivery,
        'shipped-order',
        OrderStatus.DELIVERED,
      );
    });
  });
});
