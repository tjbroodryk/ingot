import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthenticationFailed } from '../../../shared/domain/index.js';
import { AUTHENTICATOR, type Authenticator } from '../../../auth/authenticator.port.js';
import { ACCOUNT_BINDING, type AccountBinding } from './account.decorator.js';
import { attachPrincipal } from './principal-resolution.js';

/**
 * Authentication: establishes who is calling, via the `AUTHENTICATOR` port.
 * Runs before `AccountScopeGuard`, which decides what they may reach. A route
 * with no binding is left for the next guard to refuse.
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
