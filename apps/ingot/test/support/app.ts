import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { AuthMode } from '../../src/auth/auth-mode.js';
import type { AuthSettings } from '../../src/auth/auth-settings.js';
import { ApiKey } from '../../src/contexts/accounts/domain/index.js';
import { TICKERS } from '../../src/sweepers/scheduler.js';

/** A root credential for a test, minted fresh per process. */
export const TEST_ROOT_KEY = ApiKey.mint();

export const TEST_AUTH: AuthSettings = {
  mode: AuthMode.Sealed,
  slug: 'test-sealed',
  keyDigest: TEST_ROOT_KEY.digest,
  keyPrefix: TEST_ROOT_KEY.prefix,
};

/**
 * The real `AppModule` with the scheduler's ticker list emptied, so no sweeper
 * runs on a timer during a test. A test drives a sweep with `tick()` itself.
 *
 * Auth is passed in rather than read from the environment; `SealedAuthenticator`
 * seeds its account on bootstrap, so compiling this opens `test-sealed`.
 */
export function compileAppModule(auth: AuthSettings = TEST_AUTH): TestingModuleBuilder {
  return Test.createTestingModule({ imports: [AppModule.forRoot(auth)] })
    .overrideProvider(TICKERS)
    .useValue([]);
}
