import { SetMetadata, applyDecorators } from '@nestjs/common';

export const ACCOUNT_BINDING = 'ingot:account-binding';

export interface AccountBinding {
  /** No key required. */
  readonly open: boolean;
  /** The path param carrying the account slug. */
  readonly param: string;
}

/**
 * Declares how a route is scoped to an account.
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

/** Marks a route as unauthenticated. */
Account.Open = function Open(): MethodDecorator & ClassDecorator {
  const binding: AccountBinding = { open: true, param: 'account' };
  return applyDecorators(SetMetadata(ACCOUNT_BINDING, binding));
};
