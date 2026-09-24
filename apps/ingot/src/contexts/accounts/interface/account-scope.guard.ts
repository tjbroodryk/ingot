import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ActionNotPermitted } from '../../../shared/domain/index.js';
import { ACCOUNT_BINDING, type AccountBinding } from './account.decorator.js';
import { principalOf } from './principal-resolution.js';

/**
 * Fail-closed authorization. Refuses any route that declares no `@Account()`,
 * and requires the `:account` path segment to match the key's account.
 */
@Injectable()
export class AccountScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const binding = this.reflector.getAllAndOverride<AccountBinding | undefined>(ACCOUNT_BINDING, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!binding) {
      throw new ForbiddenException(
        `${context.getClass().name}.${context.getHandler().name} declares no @Account() — ` +
          'every route on this service must name the account it is scoped to, ' +
          'or say @Account.Open() if it genuinely has none.',
      );
    }
    if (binding.open) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const principal = principalOf(request);
    if (!principal) {
      // AuthenticationGuard runs first; reaching here with no principal is a guard-order bug.
      throw new ForbiddenException(
        'Authentication did not run before authorization — check the APP_GUARD order',
      );
    }

    const slug = (request.params as Record<string, string | undefined>)[binding.param];
    if (slug === undefined) {
      throw new ForbiddenException(
        `This route is scoped to :${binding.param}, but the path has no such parameter`,
      );
    }

    if (slug !== principal.account.slug.value) {
      // Same answer whether the other account exists or not.
      throw new ActionNotPermitted(
        `This key belongs to "${principal.account.slug.value}" and cannot reach "${slug}"`,
      );
    }
    return true;
  }
}
