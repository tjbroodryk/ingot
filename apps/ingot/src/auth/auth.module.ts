import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../shared/domain/index.js';
import { AccountsModule } from '../contexts/accounts/accounts.module.js';
import { AccountAuthenticator } from '../contexts/accounts/application/account-authenticator.js';
import { ACCOUNT_REPOSITORY, type AccountRepository } from '../contexts/accounts/domain/index.js';
import { AuthMode } from './auth-mode.js';
import type { AuthSettings } from './auth-settings.js';
import { AUTHENTICATOR, type Authenticator } from './authenticator.port.js';
import { SealedAuthenticator } from './sealed-authenticator.js';

/** What every adapter is allowed to ask for. */
interface Dependencies {
  readonly accounts: AccountRepository;
  readonly keys: AccountAuthenticator;
  readonly clock: Clock;
}

/** Binds the configured `Authenticator`, chosen once at boot. */
@Global()
@Module({})
export class AuthModule {
  static forRoot(settings: AuthSettings): DynamicModule {
    return {
      module: AuthModule,
      imports: [AccountsModule],
      providers: [
        {
          provide: AUTHENTICATOR,
          inject: [ACCOUNT_REPOSITORY, AccountAuthenticator, CLOCK],
          useFactory: (
            accounts: AccountRepository,
            keys: AccountAuthenticator,
            clock: Clock,
          ): Authenticator => {
            const authenticator = build(settings, { accounts, keys, clock });
            // Log which credentials this deployment honours.
            Logger.log(authenticator.describe(), 'Auth');
            return authenticator;
          },
        },
      ],
      exports: [AUTHENTICATOR],
    };
  }
}

/** Keyed on the mode, so a mode without an adapter fails to compile. */
const AUTHENTICATORS: {
  [K in AuthMode]: (settings: Extract<AuthSettings, { mode: K }>, of: Dependencies) => Authenticator;
} = {
  [AuthMode.Sealed]: (settings, of) =>
    new SealedAuthenticator(settings, of.accounts, of.keys, of.clock),
};

export function build(settings: AuthSettings, dependencies: Dependencies): Authenticator {
  // Cast for the indexed call: TS can't see `settings` narrowed by the same
  // discriminant it was indexed with.
  const make = AUTHENTICATORS[settings.mode] as (
    of: AuthSettings,
    with_: Dependencies,
  ) => Authenticator;
  return make(settings, dependencies);
}
