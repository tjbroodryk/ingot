import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { AuthMode } from '../../src/auth/auth-mode.js';
import type { AuthSettings } from '../../src/auth/auth-settings.js';
import { ApiKey } from '../../src/contexts/accounts/domain/index.js';
import { TICKERS } from '../../src/sweepers/scheduler.js';

/**
 * A root credential for a test, generated rather than written down.
 *
 * `ApiKey.mint()` so the suite never contains a string that looks like a key
 * somebody could paste into a deployment and have work. It is a fresh one per
 * process, which is all a test needs — nothing here asserts on its value, only
 * that it authenticates and that another one does not.
 */
export const TEST_ROOT_KEY = ApiKey.mint();

export const TEST_AUTH: AuthSettings = {
  mode: AuthMode.Sealed,
  slug: 'test-sealed',
  keyDigest: TEST_ROOT_KEY.digest,
  keyPrefix: TEST_ROOT_KEY.prefix,
};

/**
 * The real `AppModule`, with nothing sweeping.
 *
 * `Scheduler` is an `OnApplicationBootstrap`, so a test that compiles the whole
 * graph and calls `init()` starts the sweepers for real — against the database
 * every other file in the suite is using, on a timer that outlives the test
 * that started it. That is not theoretical: it showed up as `concurrent-add`
 * failing on a unique constraint while a roll-up ran underneath it.
 *
 * So the ticker list is emptied here, in the harness, rather than by an
 * environment variable a deployment could also set — the same argument
 * `world.ts` makes about the background workers, and the same one that got
 * `RESTATE_ENABLED` deleted. `Scheduler` itself is left real and still boots;
 * it simply has nothing to run, so a test can still assert it is wired in.
 *
 * A test that wants a sweep runs `tick()` itself. That way the suite says when
 * the background happened rather than racing it.
 *
 * The authentication settings are passed in rather than read from the
 * environment, for the same reason as the tickers: a suite that depended on
 * `INGOT_AUTH` being exported would pass or fail on the shell it was run from.
 * `SealedAuthenticator` seeds its account on bootstrap, so compiling this does
 * open `test-sealed` in the test database.
 */
export function compileAppModule(auth: AuthSettings = TEST_AUTH): TestingModuleBuilder {
  return Test.createTestingModule({ imports: [AppModule.forRoot(auth)] })
    .overrideProvider(TICKERS)
    .useValue([]);
}
