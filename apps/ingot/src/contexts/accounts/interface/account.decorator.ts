import { SetMetadata, applyDecorators } from '@nestjs/common';

export const ACCOUNT_BINDING = 'ingot:account-binding';

export interface AccountBinding {
  /** No key required. Only account creation and health may say this. */
  readonly open: boolean;
  /** The path param carrying the account slug. `account` unless stated. */
  readonly param: string;
}

/**
 * Declares how a route is scoped to an account.
 *
 * Every route must carry one. `AccountScopeGuard` refuses a route with no
 * binding rather than letting it through, so the failure mode of forgetting
 * this decorator is a route that does not work — not a route that works for
 * everybody.
 *
 * ```ts
 * @Account()                     // :account must be the authenticated account
 * @Account({ param: 'owner' })   // where a route names it something else
 * @Account.Open()                // no key at all
 * ```
 */
export function Account(options: { param?: string } = {}): MethodDecorator & ClassDecorator {
  const binding: AccountBinding = { open: false, param: options.param ?? 'account' };
  return applyDecorators(SetMetadata(ACCOUNT_BINDING, binding));
}

/**
 * Unauthenticated, deliberately.
 *
 * Spelled as a distinct call rather than `@Account({ open: true })` so that
 * every one of them is greppable, and so that adding one is a visibly
 * different act from scoping a route.
 */
Account.Open = function Open(): MethodDecorator & ClassDecorator {
  const binding: AccountBinding = { open: true, param: 'account' };
  return applyDecorators(SetMetadata(ACCOUNT_BINDING, binding));
};
