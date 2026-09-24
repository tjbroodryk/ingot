import type { ExecutionContext } from '@nestjs/common';
import { AuthenticationFailed } from '../../../shared/domain/index.js';
import type { Principal } from '../../../auth/authenticator.port.js';

const PRINCIPAL = Symbol.for('ingot.principal');

interface Carrier {
  [PRINCIPAL]?: Principal;
}

/** Attaches the principal to a request, keyed by symbol so it cannot be set by assignment. */
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
