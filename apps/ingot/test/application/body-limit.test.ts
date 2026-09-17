import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttp } from '../../src/http/body-limit.js';
import { TEST_ROOT_KEY, compileAppModule } from '../support/app.js';
import { closeDatabase, openDatabase } from '../support/database.js';

/**
 * A tool result past Express's 100 KiB default reaches `/add`.
 *
 * Over a real socket, because the limit belongs to the body parser in front of
 * every controller — nothing inside the module graph sees a request it refused.
 */
describe('a large JSON body', () => {
  let app: NestExpressApplication;
  let base: string;

  const post = (path: string, body: string) =>
    fetch(`${base}/api/v1/test-sealed/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_ROOT_KEY.secret}`,
        'content-type': 'application/json',
      },
      body,
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

  it('is accepted up to the limit, well past 100 KiB', async () => {
    const created = await post('create', JSON.stringify({ name: 'large results' }));
    const { id } = (await created.json()) as { id: string };

    const result = { output: 'x'.repeat(600 * 1024) };
    const added = await post(
      `${id}/add`,
      JSON.stringify({
        table: 'results',
        columns: { output: { from: '$.output', type: 'VARCHAR' } },
        result,
      }),
    );

    expect(added.status).toBe(201);
    expect(((await added.json()) as { rowsAdded: number }).rowsAdded).toBe(1);
  });

  it('is refused past it, with a 413', async () => {
    const response = await post('create', JSON.stringify({ name: 'y'.repeat(2 * 1024 * 1024) }));
    expect(response.status).toBe(413);
  });
});
