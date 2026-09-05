import { UserRole } from '@prisma/client';
import { AppAbilityFactory } from './app-ability.factory';

describe('AppAbilityFactory', () => {
  const factory = new AppAbilityFactory();

  it('allows a manager to maintain catalog models but not client-only models', () => {
    const ability = factory.createForUser({
      id: 'manager-1',
      email: 'manager@example.test',
      role: UserRole.MANAGER,
    });

    expect(ability.can('create', 'Category')).toBe(true);
    expect(ability.can('update', 'Product')).toBe(true);
    expect(ability.can('delete', 'ProductImage')).toBe(true);
    expect(ability.can('create', 'Sku')).toBe(true);
    expect(ability.can('read', 'Cart')).toBe(false);
    expect(ability.can('create', 'Order')).toBe(false);
    expect(ability.can('update', 'ProductLike')).toBe(false);
  });

  it('does not grant a client catalog maintenance permissions', () => {
    const ability = factory.createForUser({
      id: 'client-1',
      email: 'client@example.test',
      role: UserRole.CLIENT,
    });

    expect(ability.can('create', 'Category')).toBe(false);
    expect(ability.can('update', 'Product')).toBe(false);
    expect(ability.can('delete', 'Sku')).toBe(false);
  });

  /**
   * The DELIVERY block in `app-ability.factory.ts` is the student's
   * deliverable, and so are these assertions: an `expect` written next to a
   * generated rule ratifies the rule instead of testing it, condition bugs
   * included. Each stub below names one case exactly, and the PR that carries
   * them is not finished until they are `it(...)` with a body.
   *
   * Two of them are worth more than the rest, because they are the ones that
   * fail open rather than closed. A missing condition on `read Order` yields
   * `{}` from `accessibleBy`, which is a Prisma `where` that matches every
   * row: the courier is handed every client's order with a 200. And a
   * condition naming a column that is not on `Order` fails as a 500 rather
   * than as a refusal — broken instead of open, and still wrong. Neither is
   * something `can('read', 'Order')` alone can see, which is why the scope
   * stubs assert `accessibleBy(...).ofType('Order')` and not just the verdict.
   */
  describe('the DELIVERY rules', () => {
    it.todo(
      'grants read and update on Order, so PoliciesGuard lets a courier reach listOrders, getOrder and updateOrderStatus',
    );

    it.todo(
      'does not grant create on Order, so a courier gets 403 on checkout rather than an empty cart',
    );

    it.todo(
      'does not grant the client-only subjects Cart, CartItem and ProductLike',
    );

    it.todo(
      'does not grant catalog maintenance on Category, Product, Sku or ProductImage',
    );

    it.todo(
      "accessibleBy(ability, 'read').ofType('Order') yields { OR: [{ status: SHIPPED }, { deliveredById: the caller }] } and never {}",
    );

    it.todo(
      "accessibleBy(ability, 'update').ofType('Order') yields the same scope as read, so a courier cannot move an order it cannot see",
    );

    it.todo(
      'names the calling courier in deliveredById and never a second courier, so one delivery does not become another one',
    );

    it.todo(
      'grants nothing at all to an undefined caller, so the scope collapses to { OR: [] } and matches no row',
    );
  });
});
