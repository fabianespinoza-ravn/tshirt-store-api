import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { AbilityBuilder } from '@casl/ability';
import { createPrismaAbility } from '@casl/prisma';
import { CheckPolicies } from '../casl/check-policies.decorator';
import {
  AppAbilityFactory,
  type AppAbility,
} from '../casl/app-ability.factory';
import { ProblemException } from '../../common/problem/problem.exception';
import { PoliciesGuard } from './policies.guard';

class ProtectedHandler {
  @CheckPolicies({ action: 'create', subject: 'Category' })
  createCategory(this: void): void {}

  @CheckPolicies({ action: 'update', subject: 'Order' })
  updateOrder(this: void): void {}
}

function contextFor(
  role: UserRole,
  handler = ProtectedHandler.prototype.createCategory,
) {
  return {
    getHandler: () => handler,
    getClass: () => ProtectedHandler,
    switchToHttp: () => ({
      getRequest: () => ({
        user: { id: 'user-1', email: 'user@example.test', role },
      }),
    }),
  };
}

describe('PoliciesGuard', () => {
  const guard = new PoliciesGuard(new Reflector(), new AppAbilityFactory());

  it('allows a manager to create a category required by handler metadata', () => {
    expect(guard.canActivate(contextFor(UserRole.MANAGER) as never)).toBe(true);
  });

  it('returns the contract 403 when a client lacks the declared catalog permission', () => {
    try {
      guard.canActivate(contextFor(UserRole.CLIENT) as never);
      fail('expected PoliciesGuard to reject the client');
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemException);
      expect((error as ProblemException).kind.status).toBe(403);
    }
  });

  it('does not treat a conditional ownership rule as a role-only grant', () => {
    const { can, build } = new AbilityBuilder<AppAbility>(createPrismaAbility);
    can('update', 'Order', { userId: 'ana' });
    const conditionalFactory = {
      createForUser: () => build(),
    } as AppAbilityFactory;
    const conditionalGuard = new PoliciesGuard(
      new Reflector(),
      conditionalFactory,
    );

    expect(() =>
      conditionalGuard.canActivate(
        contextFor(
          UserRole.CLIENT,
          ProtectedHandler.prototype.updateOrder,
        ) as never,
      ),
    ).toThrow(ProblemException);
  });
});
