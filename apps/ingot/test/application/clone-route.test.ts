import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttp } from '../../src/http/body-limit.js';
import { TEST_ROOT_KEY, compileAppModule } from '../support/app.js';
import { closeDatabase, openDatabase } from '../support/database.js';

/** `POST /:account/:ingot/clone` over a socket: the pipe, the status codes. */
describe('the clone route', () => {
  let app: NestExpressApplication;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/v1/test-sealed/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_ROOT_KEY.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const { truncate } = await openDatabase();
    await truncate();

    const module = await compileAppModule().compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureHttp(app, { bodyLimit: 1024 * 1024 });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it('answers 201 for a new clone and 200 for one its externalId already names', async () => {
    const created = await post('create', { name: 'source' });
    const { id } = (await created.json()) as { id: string };

    const first = await post(`${id}/clone`, { externalId: 'copy-1' });
    const second = await post(`${id}/clone`, { externalId: 'copy-1' });
    const bare = await post(`${id}/clone`, {});

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(bare.status).toBe(201);

    const [a, b] = (await Promise.all([first.json(), second.json()])) as { id: string }[];
    expect(b?.id).toBe(a?.id as string);
    expect(((await bare.json()) as { name: string }).name).toBe('source');
  });

  it('refuses a retention it cannot read, and an id that is not there', async () => {
    const created = await post('create', { name: 'source' });
    const { id } = (await created.json()) as { id: string };

    expect((await post(`${id}/clone`, { retainFor: 'soon' })).status).toBe(400);
    expect((await post('ing_000000000000000000000000/clone', {})).status).toBe(404);
  });
});
