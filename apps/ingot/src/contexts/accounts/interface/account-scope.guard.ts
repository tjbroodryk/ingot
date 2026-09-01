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
 * Authorization, and the fail-closed rule of this service.
 *
 * A route that declares no `@Account()` is refused. Not allowed-by-default,
 * not warned about — refused, with a message that says what is missing. The
 * alternative is that forgetting a decorator silently publishes an endpoint,
 * which is the failure nobody notices until it is in someone else's logs.
 *
 * `route-accounts.test.ts` catches this before it ships by walking every
 * controller on disk; this guard is what catches the one the test could not
 * see, such as a route added by a dynamically registered module.
 *
 * The second job is the one that actually separates tenants: the `:account` in
 * the path must be the account the key belongs to. Without this, every key is
 * a key to every account, since the ingot id in the next segment is the only
 * other thing identifying the data.
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
      // ApiKeyGuard runs first and would have thrown. Reaching here means the
      // guards were reordered, so this is a wiring bug rather than a caller's.
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
      // Deliberately the same answer whether the other account exists or not.
      throw new ActionNotPermitted(
        `This key belongs to "${principal.account.slug.value}" and cannot reach "${slug}"`,
      );
    }
    return true;
  }
}
