import { type Env, type EnvSource, loadEnv } from '../../src/config/env.js';
import { ApiKey } from '../../src/contexts/accounts/domain/index.js';
import { CONNECTION } from './database.js';

/**
 * A root credential for a test, generated rather than written down.
 *
 * `ApiKey.mint()` so the suite never contains a string that looks like a key
 * somebody could paste into a deployment and have work. It is a fresh one per
 * process, which is all a test needs — nothing here asserts on its value, only
 * that it authenticates and that another one does not.
 */
export const TEST_ROOT_KEY = ApiKey.mint();

/**
 * The environment every test runs against, and never the shell's.
 *
 * Bun loads `apps/ingot/.env` automatically, which is right for `bun run dev`
 * and wrong for `bun run test`: a developer who has configured a real model
 * would have the suite embed and summarise through it — a test run that needs
 * a network, needs credentials, **costs money**, and answers differently on
 * their machine than on anybody else's. The same goes for `DATABASE_URL`,
 * which in a developer's `.env` points at the database they keep local state
 * in, while `truncate()` empties this one.
 *
 * So the harness never reads `process.env` for the service's settings. It
 * parses this record, through the same `loadEnv` a deployment goes through,
 * and a test that needs something else passes it as an override.
 *
 * The offline stand-ins are pinned rather than left to their defaults:
 * `HashEmbedder` and `ExtractiveSummariser` exist so the whole pipeline can be
 * exercised with no network, no key and no bill, and a test that wants a real
 * model injects it, as `receipt-transaction.test.ts` does.
 */
export function testEnv(overrides: EnvSource = {}): Env {
  return loadEnv({
    INGOT_AUTH: 'sealed',
    INGOT_ACCOUNT: 'test-sealed',
    INGOT_API_KEY: TEST_ROOT_KEY.secret,
    DATABASE_URL: CONNECTION,
    INGOT_EMBEDDER: 'local',
    INGOT_SUMMARISER: 'local',
    TRACING_ENABLED: 'false',
    METRICS_ENABLED: 'false',
    ...overrides,
  });
}
