import 'reflect-metadata';
import type { RequestListener } from 'node:http';
import { type EnvSource, loadEnv } from './config/env.js';
import { build } from './serve.js';

export interface EmbeddedIngot {
  /**
   * The whole API as one request handler, for `app.use('/ingot', handler)` or
   * `http.createServer(handler)`. Routes below the mount are `/api/v1/...`.
   * Mount it before the host's body parsers: it reads the request stream itself.
   */
  readonly handler: RequestListener;
  /** Stops the sweepers and closes the pools. The host calls this on shutdown. */
  close(): Promise<void>;
}

/**
 * Ingot inside somebody else's server: the same service, without a port.
 *
 * Telemetry and signal handlers are left alone because both are process-wide
 * and the process is the host's. `PORT` is read and ignored.
 */
export async function createIngot(source: EnvSource = process.env): Promise<EmbeddedIngot> {
  const app = await build(loadEnv(source));
  await app.init();
  return { handler: app.getHttpAdapter().getInstance(), close: () => app.close() };
}
