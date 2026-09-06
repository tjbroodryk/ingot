import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { compileAppModule } from '../support/app.js';
import { ACCOUNT_REPOSITORY } from '../../src/contexts/accounts/domain/index.js';
import { AccountAuthenticator } from '../../src/contexts/accounts/application/account-authenticator.js';
import { AUTHENTICATOR } from '../../src/auth/authenticator.port.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
} from '../../src/contexts/ingots/domain/index.js';
import { IngotAccess } from '../../src/contexts/ingots/application/ingot-access.js';
import { OVERLAY_STORE } from '../../src/contexts/records/application/ports/overlay-store.port.js';
import { EMBEDDER } from '../../src/ai/embedder.port.js';
import { SUMMARISER } from '../../src/ai/summariser.port.js';
import { BACKGROUND_CONCURRENCY } from '../../src/contexts/records/application/background.js';
import { DELIVERY_OUTBOX } from '../../src/contexts/records/application/ports/delivery-outbox.port.js';
import { RECEIPT_NOTIFIER } from '../../src/contexts/records/application/ports/receipt-notifier.port.js';
import { DeliveryWorker } from '../../src/contexts/records/application/delivery-worker.js';
import { DELIVERY_SETTINGS } from '../../src/delivery/delivery-settings.js';
import { DELIVERY_TRANSPORT } from '../../src/delivery/delivery-transport.port.js';
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
    await openDatabase();
    app = await compileAppModule().compile();
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
    // The port the guard resolves, and the digest lookup every mode composes.
    // Both, because binding one without the other is a service that either
    // cannot authenticate or cannot honour a minted key.
    ['the authenticator the guards use', AUTHENTICATOR],
    ['the key lookup behind it', AccountAuthenticator],
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
    // All three halves of delivery, because binding one without the others is
    // a service that either announces receipts nothing sends, or sends them
    // with no settings to say where. The outbox is bound in `OverlayModule`
    // and the transport in `DeliveryModule` — two modules away from the worker
    // that needs both, which is exactly the arrangement this file exists for.
    ['the delivery outbox', DELIVERY_OUTBOX],
    ['the delivery transport', DELIVERY_TRANSPORT],
    ['the delivery settings', DELIVERY_SETTINGS],
    // The three workers the sweepers call directly rather than dispatching, so
    // that nobody else's model or endpoint is called while a transaction is open.
    ['the embed worker', EmbedWorker],
    ['the receipt worker', ReceiptWorker],
    ['the delivery worker', DeliveryWorker],
    // Not a port, but bound the same way and for the same reason: a constructor
    // default is not optional to Nest, so an unbound limit is a container that
    // refuses to build the thing every wake goes through.
    ['the background concurrency bound', BACKGROUND_CONCURRENCY],
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
