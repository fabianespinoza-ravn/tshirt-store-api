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
        this.hasPermission(ability, action, subject),
      )
    ) {
      throw new ProblemException(
        Problems.forbidden,
        'The authenticated user is not allowed to perform this operation.',
      );
    }

    return true;
  }

  /**
   * Authorizes by role, and by role alone. A rule that carries an ownership
   * condition satisfies this gate as well: the condition cannot be judged
   * here, because the guard holds a subject *type* and not the row, so it
   * is applied where the row is fetched, as
   * `accessibleBy(ability, action).ofType('Subject')` folded into the
   * service's Prisma `where`.
   *
   * The consequence has to be said plainly, because it is the whole risk of
   * this design. Before the cart, a conditional rule failed this check and
   * the route answered 403; a service that forgot to scope its query was
   * therefore unreachable. Now such a route is reachable, and a service
   * that forgets answers 200 with another client's row. The compensating
   * controls are the unit test asserting the `where` the service sends to
   * Prisma, and the `casl-guard` agent over the diff. There is nothing
   * else.
   *
   * `can()` still does real work: it denies a role the ability grants no
   * rule for, and it respects an explicit `cannot`.
   */
  private hasPermission(
    ability: ReturnType<AppAbilityFactory['createForUser']>,
    action: PolicyRequirement['action'],
    subject: PolicyRequirement['subject'],
  ): boolean {
    return ability.can(action, subject);
  }
}
