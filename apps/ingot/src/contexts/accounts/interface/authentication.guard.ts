import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthenticationFailed } from '../../../shared/domain/index.js';
import { AUTHENTICATOR, type Authenticator } from '../../../auth/authenticator.port.js';
import { ACCOUNT_BINDING, type AccountBinding } from './account.decorator.js';
import { attachPrincipal } from './principal-resolution.js';

/**
 * Authentication: establishes who is calling, and nothing else.
 *
 * Runs before `AccountScopeGuard`, which decides what they may reach. Keeping
 * the two apart is the same split `@forge/api` makes between `AccessTokenGuard`
 * and `ScopeGuard`, and it matters here for the same reason: "your key is not
 * valid" and "your key is not valid *for this account*" are different answers
 * and want different status codes.
 *
 * It resolves the `AUTHENTICATOR` port rather than one implementation, and
 * that is the extent of what it knows: whether this deployment accepts a
 * configured root key, a minted one, or something else entirely is decided by
 * `INGOT_AUTH` at boot and is not a fact any route has to carry. Adding a mode
 * changes `src/auth/`, and nothing here.
 *
 * A route with no binding at all is left alone here and refused by the next
 * guard. Deciding that in one place means there is one message to read when it
 * happens, and one test to hold it up.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const binding = this.reflector.getAllAndOverride<AccountBinding | undefined>(ACCOUNT_BINDING, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (binding?.open) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const presented = bearer(request.headers.authorization);
    if (!presented) {
      throw new AuthenticationFailed(
        'This endpoint needs an API key: send it as `Authorization: Bearer ing_sk_…`',
      );
    }

    attachPrincipal(request, await this.authenticator.authenticate(presented));
    return true;
  }
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}
