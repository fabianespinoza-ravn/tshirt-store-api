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

  /**
   * A guard whose ability carries one conditional rule and nothing else,
   * which is the shape every CLIENT-owned resource now has.
   */
  const withConditionalRule = () => {
    const { can, build } = new AbilityBuilder<AppAbility>(createPrismaAbility);
    can('update', 'Order', { userId: 'ana' });
    return new PoliciesGuard(new Reflector(), { createForUser: () => build() });
  };

  const updateOrderAsClient = () =>
    contextFor(UserRole.CLIENT, ProtectedHandler.prototype.updateOrder);

  /**
   * This branch reverses what the guard did until the cart landed: a
   * conditional rule used to fail the check, so a route whose rule carried
   * an owner condition answered 403 to everyone. The row scope moved to the
   * services. The harness above is ready; the assertions are the student's,
   * per CLAUDE.md, because the change under test is the assistant's.
   */
  it.todo(
    'lets a conditional ownership rule through the role gate, leaving the row scope to the service',
  );
  it.todo(
    'still refuses a subject the ability grants no rule for, conditional or otherwise',
  );

  // Keeps the harness referenced while the two cases have no body.
  void withConditionalRule;
  void updateOrderAsClient;
});
