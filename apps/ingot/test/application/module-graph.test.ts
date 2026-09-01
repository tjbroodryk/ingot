import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { ACCOUNT_REPOSITORY } from '../../src/contexts/accounts/domain/index.js';
import { AccountAuthenticator } from '../../src/contexts/accounts/application/account-authenticator.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
} from '../../src/contexts/ingots/domain/index.js';
import { IngotAccess } from '../../src/contexts/ingots/application/ingot-access.js';
import { OVERLAY_STORE } from '../../src/contexts/records/application/ports/overlay-store.port.js';
import { EMBEDDER } from '../../src/ai/embedder.port.js';
import { SUMMARISER } from '../../src/ai/summariser.port.js';
import { RECEIPT_NOTIFIER } from '../../src/contexts/records/application/ports/receipt-notifier.port.js';
import { ReceiptWorker } from '../../src/contexts/records/application/receipt-worker.js';
import { EmbedWorker } from '../../src/contexts/records/application/embed-worker.js';
import { ANALYTICAL_ENGINE } from '../../src/engine/analytical-engine.port.js';
import { SessionBuilder } from '../../src/engine/session-builder.js';
import { OBJECT_STORE } from '../../src/storage/object-store.port.js';
import { Dispatcher, UNIT_OF_WORK } from '../../src/shared/application/index.js';
import { CLOCK } from '../../src/shared/domain/index.js';
import { SWEEPERS } from '../../src/sweepers/sweepers.module.js';
import { SweptKind } from '../../src/sweepers/kinds.js';
import { IngotMcpServer } from '../../src/mcp/ingot-server.js';
import { closeDatabase, openDatabase } from '../support/database.js';

/**
 * The real `AppModule`, compiled.
 *
 * Every other test in this suite assembles only the modules it needs, which is
 * what keeps them quick and what makes them blind to this: a port bound in one
 * module and injected in another fails here rather than at four in the morning
 * on the first request that happens to need it.
 *
 * Adding a context, a port, or a cross-context adapter means adding its token
 * to the table below. `CLAUDE.md` is explicit that this is the alternative to
 * booting the server to check your work — a boot proves it once, on one
 * machine, for as long as somebody is looking at it.
 */
describe('the real module graph', () => {
  let app: TestingModule;

  beforeAll(async () => {
    const { pool } = await openDatabase();
    process.env.DATABASE_URL ??= (pool.options.connectionString as string) ?? '';
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it.each([
    ['the dispatcher', Dispatcher],
    ['the unit of work', UNIT_OF_WORK],
    ['the clock', CLOCK],
    ['the account repository', ACCOUNT_REPOSITORY],
    ['the authenticator both guards use', AccountAuthenticator],
    ['the ingot repository', INGOT_REPOSITORY],
    ['the table repository', INGOT_TABLE_REPOSITORY],
    ['the tenancy check', IngotAccess],
    ['the overlay store', OVERLAY_STORE],
    ['the object store', OBJECT_STORE],
    ['the analytical engine', ANALYTICAL_ENGINE],
    ['the session builder', SessionBuilder],
    ['the embedder', EMBEDDER],
    ['the summariser', SUMMARISER],
    ['the receipt notifier', RECEIPT_NOTIFIER],
    // The two workers the sweepers call directly rather than dispatching, so
    // that a model is never asked while a transaction is open.
    ['the embed worker', EmbedWorker],
    ['the receipt worker', ReceiptWorker],
    ['the MCP bridge', IngotMcpServer],
  ])('resolves %s', (_name, token) => {
    expect(app.get(token as never, { strict: false })).toBeDefined();
  });

  it('serves a ticker for every kind of thing that can fall behind', () => {
    for (const kind of Object.values(SweptKind)) {
      const sweeper = SWEEPERS[kind];
      expect(sweeper).toBeDefined();
      // Resolvable, not merely listed: a sweeper whose dependencies are not
      // bound is a schedule that stops on its first tick.
      expect(app.get(sweeper, { strict: false })).toBeDefined();
      expect(typeof app.get(sweeper, { strict: false }).tick).toBe('function');
    }
  });
});
