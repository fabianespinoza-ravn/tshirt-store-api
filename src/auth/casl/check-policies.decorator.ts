import { SetMetadata } from '@nestjs/common';
import type { AppAction, AppSubjectName } from './app-ability.factory';

export const CHECK_POLICIES_KEY = 'check_policies';

export interface PolicyRequirement {
  action: AppAction;
  subject: AppSubjectName;
}

export const CheckPolicies = (...requirements: PolicyRequirement[]) =>
  SetMetadata(CHECK_POLICIES_KEY, requirements);
