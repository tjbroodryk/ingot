import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import type { Env } from '../../src/config/env.js';
import { TICKERS } from '../../src/sweepers/scheduler.js';
import { testEnv } from './env.js';

export { TEST_ROOT_KEY } from './env.js';

export const TEST_AUTH = testEnv().auth;

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
 * The environment is `testEnv()` rather than the shell's — see `env.ts`.
 * `SealedAuthenticator` seeds its account on bootstrap, so compiling this does
 * open `test-sealed` in the test database.
 */
export function compileAppModule(env: Env = testEnv()): TestingModuleBuilder {
  return Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(TICKERS)
    .useValue([]);
}
