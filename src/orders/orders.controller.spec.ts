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

  it.todo(
    'places an order with the authenticated caller and the posted address',
  );
  it.todo('returns the page the service produced, untouched');
  it.todo('passes the whole query object through, so no filter is dropped');
  it.todo('resolves one order by the id in the path, for the caller');
  it.todo('sends the destination status from the body, not from the path');
  it.todo('never derives the caller from the request body or the path');

  void order;
  void page;
  void controller;
  void address;
  void client;
  void manager;
});
