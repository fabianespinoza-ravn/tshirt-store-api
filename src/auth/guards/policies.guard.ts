import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestWithUser } from '../../common/decorators/current-user.decorator';
import { Problems } from '../../common/problem/problem.catalog';
import { ProblemException } from '../../common/problem/problem.exception';
import { AppAbilityFactory } from '../casl/app-ability.factory';
import {
  CHECK_POLICIES_KEY,
  type PolicyRequirement,
} from '../casl/check-policies.decorator';

// A protected route with no @CheckPolicies metadata is denied by default, so
// forgetting it doesn't leave an operation wide open.
@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilities: AppAbilityFactory,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requirements =
      this.reflector.getAllAndOverride<PolicyRequirement[]>(
        CHECK_POLICIES_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const ability = this.abilities.createForUser(request.user);

    if (
      requirements.length === 0 ||
      !requirements.every(({ action, subject }) =>
        this.hasRoleOnlyPermission(ability, action, subject),
      )
    ) {
      throw new ProblemException(
        Problems.forbidden,
        'The authenticated user is not allowed to perform this operation.',
      );
    }

    return true;
  }

  // Authorizes by role only: a CASL rule with conditions needs the actual
  // row, applied in the services with accessibleBy(...).ofType(...);
  // ability.can(...) isn't redundant because it's the only thing that
  // catches an unconditional cannot that rulesFor alone wouldn't reflect.
  private hasRoleOnlyPermission(
    ability: ReturnType<AppAbilityFactory['createForUser']>,
    action: PolicyRequirement['action'],
    subject: PolicyRequirement['subject'],
  ): boolean {
    return (
      ability.can(action, subject) &&
      ability
        .rulesFor(action, subject)
        .some((rule) => !rule.inverted && rule.conditions === undefined)
    );
  }
}
