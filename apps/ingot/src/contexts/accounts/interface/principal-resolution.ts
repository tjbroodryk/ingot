import type { ExecutionContext } from '@nestjs/common';
import { AuthenticationFailed } from '../../../shared/domain/index.js';
import type { Principal } from '../../../auth/authenticator.port.js';

const PRINCIPAL = Symbol.for('ingot.principal');

interface Carrier {
  [PRINCIPAL]?: Principal;
}

/**
 * The one place a principal is attached to a request and the one place it is
 * read back.
 *
 * A symbol rather than `request.principal`, so nothing downstream can set it
 * by assigning a plausible-looking property, and so a guard and a param
 * decorator cannot disagree about where it lives.
 */
export function attachPrincipal(request: object, principal: Principal): void {
  (request as Carrier)[PRINCIPAL] = principal;
}

export function principalOf(request: object): Principal | undefined {
  return (request as Carrier)[PRINCIPAL];
}

export function requirePrincipal(context: ExecutionContext): Principal {
  const principal = principalOf(context.switchToHttp().getRequest());
  if (!principal) {
    throw new AuthenticationFailed('This request was not authenticated');
  }
  return principal;
}
