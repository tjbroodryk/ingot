import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Account } from '../domain/index.js';
import { requirePrincipal } from './principal-resolution.js';

/** The authenticated account. Throws on an open route, which has none. */
export const CurrentAccount = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Account => requirePrincipal(context).account,
);
