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

/**
 * How this deployment authenticates, chosen once at boot.
 *
 * `forRoot` rather than a plain module because the settings are parsed in
 * `main.ts`, before the container exists — a mode named without the values it
 * needs has to be fatal before anything is listening, not on the first request
 * that discovers it. See the note there.
 *
 * Global because `AuthenticationGuard` is bound with `APP_GUARD` in
 * `AppModule` and runs on every route in the service; it resolves
 * `AUTHENTICATOR` from here and never learns which adapter it got, which is
 * the whole point of the selector.
 *
 * This module imports `AccountsModule` rather than the other way round, and
 * the direction matters: the accounts context knows how to store an account
 * and check a digest, and this decides whether that is what a deployment does.
 * A context that imported its own selector would be a context that could only
 * be assembled one way.
 */
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
            // One line per port, the way `AiModule` and `StorageModule` each
            // say what they resolved to. Which credentials a running service
            // honours should be readable off the start of a pod log.
            Logger.log(authenticator.describe(), 'Auth');
            return authenticator;
          },
        },
      ],
      exports: [AUTHENTICATOR],
    };
  }
}

/**
 * Keyed on the mode, so adding one to `AuthMode` without an adapter fails to
 * compile rather than falling through to a default at runtime.
 */
const AUTHENTICATORS: {
  [K in AuthMode]: (settings: Extract<AuthSettings, { mode: K }>, of: Dependencies) => Authenticator;
} = {
  [AuthMode.Sealed]: (settings, of) =>
    new SealedAuthenticator(settings, of.accounts, of.keys, of.clock),
};

export function build(settings: AuthSettings, dependencies: Dependencies): Authenticator {
  // The cast is for the indexed call alone: the record narrows its argument
  // per key, and TypeScript cannot see that `settings` was narrowed by the
  // same discriminant it was just indexed with.
  const make = AUTHENTICATORS[settings.mode] as (
    of: AuthSettings,
    with_: Dependencies,
  ) => Authenticator;
  return make(settings, dependencies);
}
