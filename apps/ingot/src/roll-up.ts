import 'reflect-metadata';
import { loadEnv } from './config/env.js';
import { serve } from './serve.js';
import { SweptKind } from './sweepers/kinds.js';

/**
 * The same service, running the roll-up sweep and no other.
 *
 * For a deployment that gives compaction its own process, so it can be sized
 * for `INGOT_ROLLUP_CONCURRENCY` DuckDB sessions without the API paying for
 * them. The API side then sets `INGOT_SKIP_SWEEPERS=roll_up`. It still listens,
 * for health checks and `/metrics`; nothing needs to send it requests.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  await serve({ ...env, sweepers: { run: [SweptKind.RollUp] } }, 'Ingot roll-up');
}

void bootstrap();
