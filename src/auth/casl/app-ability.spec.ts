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
});
