import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type EmbeddedIngot, createIngot } from '../../src/embed.js';
import { SweptKind } from '../../src/sweepers/kinds.js';
import { CONNECTION, closeDatabase, openDatabase } from '../support/database.js';
import { TEST_ROOT_KEY } from '../support/env.js';

/** `createIngot` behind a server it did not start. */
describe('the embedded service', () => {
  let ingot: EmbeddedIngot;
  let host: Server;
  let base: string;

  beforeAll(async () => {
    const { truncate } = await openDatabase();
    await truncate();

    ingot = await createIngot({
      INGOT_AUTH: 'sealed',
      INGOT_ACCOUNT: 'test-sealed',
      INGOT_API_KEY: TEST_ROOT_KEY.secret,
      DATABASE_URL: CONNECTION,
      INGOT_EMBEDDER: 'local',
      INGOT_SUMMARISER: 'local',
      // Nothing sweeping under the rest of the suite; see `support/app.ts`.
      INGOT_SKIP_SWEEPERS: Object.values(SweptKind).join(','),
    });

    host = createServer(ingot.handler);
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => host?.close(resolve));
    await ingot?.close();
    await closeDatabase();
  });

  it('answers the API through the host, body and auth included', async () => {
    const cast = (key: string) =>
      fetch(`${base}/api/v1/test-sealed/cast`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'embedded' }),
      });

    const created = await cast(TEST_ROOT_KEY.secret);
    expect(created.status).toBe(201);
    expect(((await created.json()) as { name: string }).name).toBe('embedded');

    expect((await cast('not-a-key')).status).toBe(401);
  });

  it('leaves the process to the host', () => {
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});
