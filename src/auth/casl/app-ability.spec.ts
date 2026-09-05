import { accessibleBy } from '@casl/prisma';
import { OrderStatus, Prisma, UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AppAbilityFactory, type AppAction } from './app-ability.factory';
import { exactlyTheseInAnyOrder } from '../../testing/matchers';

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
   * The DELIVERY block in `app-ability.factory.ts` is covered here directly:
   * an `expect` written next to a generated rule ratifies the rule instead of
   * testing it, condition bugs included. Each case names one contract exactly.
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
    /**
     * The row scope as a Prisma `where`, resolved exactly the way
     * `OrdersService.scope` resolves it. The return type is declared here for
     * the same reason it is declared there: `ofType` is typed loosely, and a
     * bare assignment would leave these cases comparing an `any`.
     */
    const scopeFor = (
      caller: AuthenticatedUser,
      action: AppAction,
    ): Prisma.OrderWhereInput =>
      accessibleBy(factory.createForUser(caller), action).ofType('Order');

    const delivery = {
      id: 'delivery-1',
      email: 'delivery@example.test',
      role: UserRole.DELIVERY,
    };

    it('grants read and update on Order', () => {
      const ability = factory.createForUser(delivery);

      expect(ability.can('read', 'Order')).toBe(true);
      expect(ability.can('update', 'Order')).toBe(true);
    });

    it('does not grant create on Order', () => {
      expect(factory.createForUser(delivery).can('create', 'Order')).toBe(
        false,
      );
    });

    it('does not grant the client-only subjects', () => {
      const ability = factory.createForUser(delivery);

      expect(ability.can('read', 'Cart')).toBe(false);
      expect(ability.can('read', 'CartItem')).toBe(false);
      expect(ability.can('read', 'ProductLike')).toBe(false);
    });

    it('does not grant catalog maintenance', () => {
      const ability = factory.createForUser(delivery);

      expect(ability.can('create', 'Category')).toBe(false);
      expect(ability.can('update', 'Product')).toBe(false);
      expect(ability.can('create', 'Sku')).toBe(false);
      expect(ability.can('delete', 'ProductImage')).toBe(false);
    });

    it('builds the conditional read scope for shipped and own delivered orders', () => {
      const scope = scopeFor(delivery, 'read');

      expect(scope).toEqual({
        OR: exactlyTheseInAnyOrder([
          { status: OrderStatus.SHIPPED },
          { deliveredById: delivery.id },
        ]) as unknown as Prisma.OrderWhereInput[],
      });
    });

    it('uses the same conditional scope for update', () => {
      const scope = scopeFor(delivery, 'update');

      expect(scope).toEqual({
        OR: exactlyTheseInAnyOrder([
          { status: OrderStatus.SHIPPED },
          { deliveredById: delivery.id },
        ]) as unknown as Prisma.OrderWhereInput[],
      });
    });

    it('names the calling courier in the delivered-by condition', () => {
      const first = scopeFor(delivery, 'read');
      const second = scopeFor({ ...delivery, id: 'delivery-2' }, 'read');

      expect(first).toEqual({
        OR: exactlyTheseInAnyOrder([
          { status: OrderStatus.SHIPPED },
          { deliveredById: 'delivery-1' },
        ]) as unknown as Prisma.OrderWhereInput[],
      });
      expect(second).toEqual({
        OR: exactlyTheseInAnyOrder([
          { status: OrderStatus.SHIPPED },
          { deliveredById: 'delivery-2' },
        ]) as unknown as Prisma.OrderWhereInput[],
      });
    });

    it('grants nothing to an undefined caller', () => {
      const ability = factory.createForUser(undefined);

      expect(ability.can('read', 'Order')).toBe(false);
      expect(accessibleBy(ability, 'read').ofType('Order')).toEqual({ OR: [] });
    });
  });
});
