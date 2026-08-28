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

// Una ruta protegida sin metadata @CheckPolicies se deniega por defecto, para que olvidarla no abra una operación.
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

  // Autoriza solo por rol: una regla CASL con condiciones necesita la fila real, aplicada en los servicios con accessibleBy(...).ofType(...); ability.can(...) no es redundante porque es lo único que atrapa un cannot sin condiciones que rulesFor por sí solo no reflejaría.
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
