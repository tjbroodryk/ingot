import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type {
  AddBody,
  AddResult,
  ConfigureIngotBody,
  ConfigureTableBody,
  FileBody,
  FileResult,
  IngotConfig,
  IngotInfo,
  QueryBody,
  QueryResult,
  TableConfig,
} from '@ingot/shared/ingot-v1';
import { AccountsModule } from '../../src/contexts/accounts/accounts.module.js';
import { AcceptFile } from '../../src/contexts/files/application/commands/accept-file.command.js';
import { FileWorker } from '../../src/contexts/files/application/file-worker.js';
import { FileStoreModule } from '../../src/contexts/files/file-store.module.js';
import { FilesModule } from '../../src/contexts/files/files.module.js';
import { CreateAccount } from '../../src/contexts/accounts/application/commands/create-account.command.js';
import { ConfigureIngot } from '../../src/contexts/ingots/application/commands/configure-ingot.command.js';
import { ConfigureTable } from '../../src/contexts/ingots/application/commands/configure-table.command.js';
import { CreateIngot } from '../../src/contexts/ingots/application/commands/create-ingot.command.js';
import { DeleteIngot } from '../../src/contexts/ingots/application/commands/delete-ingot.command.js';
import { GetIngotInfo } from '../../src/contexts/ingots/application/queries/get-ingot-info.query.js';
import { IngotsModule } from '../../src/contexts/ingots/ingots.module.js';
import { QueryModule } from '../../src/contexts/query/query.module.js';
import { QueryIngot } from '../../src/contexts/query/application/queries/query-ingot.query.js';
import { AddRecords } from '../../src/contexts/records/application/commands/add-records.command.js';
import { CompactTable } from '../../src/contexts/records/application/commands/compact-table.command.js';
import { DeleteRecords } from '../../src/contexts/records/application/commands/delete-records.command.js';
import { DeliveryWorker } from '../../src/contexts/records/application/delivery-worker.js';
import { ReceiptWorker } from '../../src/contexts/records/application/receipt-worker.js';
import { EmbedWorker } from '../../src/contexts/records/application/embed-worker.js';
import { OverlayModule } from '../../src/contexts/records/overlay.module.js';
import { RecordsModule } from '../../src/contexts/records/records.module.js';
import {
  INGOT_TABLE_REPOSITORY,
  type IngotTableRepository,
} from '../../src/contexts/ingots/domain/index.js';
import { AiModule } from '../../src/ai/ai.module.js';
import { DeliveryModule } from '../../src/delivery/delivery.module.js';
import {
  DELIVERY_TRANSPORT,
  type DeliveryTransport,
} from '../../src/delivery/delivery-transport.port.js';
import { SUMMARISER, type Summariser } from '../../src/ai/summariser.port.js';
import { EngineModule } from '../../src/engine/engine.module.js';
import {
  BackgroundKind,
  BackgroundWork,
} from '../../src/contexts/records/application/background.js';
import { Dispatcher } from '../../src/shared/application/index.js';
import { SharedModule } from '../../src/shared/shared.module.js';
import { TestDatabaseModule } from './database-module.js';
import { openDatabase } from './database.js';

/**
 * The service, assembled for a test, with a scratch directory for its base tier.
 *
 * The real object store and the real engine — a filesystem `ObjectStore` is a
 * first-class adapter rather than a stub, so a roll-up in a test writes real
 * Parquet and reads it back through real DuckDB. The alternative would prove
 * the code compiles and nothing else, and the property this whole design rests
 * on is that a query returns the same answer either side of a roll-up.
 */
export interface World {
  readonly app: TestingModule;
  readonly dispatcher: Dispatcher;
  readonly accountId: string;
  readonly accountSlug: string;
  readonly dataDir: string;

  /**
   * Every background queue this world's writes woke, in order.
   *
   * The stand-in collects rather than runs, because what `/add` tells the
   * background is a property worth asserting on: a write that queues embedding
   * work and wakes nothing has silently lost the fast path, and the only
   * evidence is a row that stays unembedded for up to a minute in production
   * and for ever in a test.
   */
  readonly wakes: readonly BackgroundKind[];

  ingot(name?: string): Promise<string>;
  add(ingotId: string, body: AddBody): Promise<AddResult>;
  /**
   * Uploads a document, exactly as the controller would.
   *
   * The bytes and the JSON half are given separately because that is what a
   * multipart part actually delivers — going through `AcceptFile` rather than
   * through HTTP keeps the suite off a socket while still exercising every
   * check that matters, since the controller does nothing but decode the form.
   */
  file(
    ingotId: string,
    upload: { filename: string; mediaType?: string; content: string | Buffer },
    body?: FileBody,
  ): Promise<FileResult>;
  /** Reads the documents in the queue, which the sweeper would do on a tick. */
  parseAll(): Promise<number>;
  /** Destroys a memory, the way `DELETE /:account/:ingot` does. */
  destroy(ingotId: string): Promise<void>;
  query(ingotId: string, body: QueryBody): Promise<QueryResult>;
  /** A SQL query, for the common case of asserting on the rows it returns. */
  sql(ingotId: string, statement: string): Promise<QueryResult['rows']>;
  info(ingotId: string): Promise<IngotInfo>;
  configure(ingotId: string, table: string, body: ConfigureTableBody): Promise<TableConfig>;
  /** Sets where this memory's receipts are delivered. */
  configureIngot(ingotId: string, body: ConfigureIngotBody): Promise<IngotConfig>;
  forget(ingotId: string, table: string, where: string): Promise<number>;
  embedAll(): Promise<number>;
  /** Drains the receipt queue, which the sweeper would otherwise do on a tick. */
  summariseAll(): Promise<number>;
  /** Drains the delivery outbox, which the sweeper would otherwise do. */
  deliverAll(): Promise<number>;
  compact(ingotId: string, table: string): Promise<void>;
  close(): Promise<void>;
}

let accounts = 0;

/**
 * What a test may swap out.
 *
 * Only the summariser so far, and only because one property is impossible to
 * observe from outside: whether the model is asked with a transaction still
 * open. A fake that looks around while it is being called is the only vantage
 * point there is.
 */
export interface WorldOverrides {
  readonly summariser?: Summariser;
  /**
   * Where deliveries go instead of out.
   *
   * Swapped for the same reason as the summariser: the real transports call
   * somebody else, and what a test wants to assert is *what* was sent and how
   * a refusal is handled — neither of which needs a socket.
   */
  readonly transport?: DeliveryTransport;
}

export async function makeWorld(overrides: WorldOverrides = {}): Promise<World> {
  const database = await openDatabase();
  await database.truncate();

  const dataDir = mkdtempSync(join(tmpdir(), 'ingot-world-'));
  // The filesystem driver, named rather than inferred, which is the
  // composition these tests want: real Parquet, no network. A developer with
  // a bucket in their own environment does not change what the suite writes.
  process.env.INGOT_STORAGE = 'filesystem';
  process.env.INGOT_DATA_DIR = dataDir;
  // The models are pinned in `test/support/environment.ts`, preloaded before
  // any test file, because the tests that compile the real `AppModule` never
  // come through here.

  /**
   * The background, written down instead of run.
   *
   * `/add` wakes the workers the moment it commits. Left real, every write in
   * the suite would start a drain that runs after the assertion it belongs to
   * — a test would be racing its own background rather than describing it — so
   * it is bound out here, in the harness, rather than by an environment
   * variable that a deployment could also set. Overriding the provider is what
   * keeps "the suite does not drain by itself" a fact about the test, and it
   * means the production path has no branch in it to be wrong about.
   *
   * `embedAll` and `summariseAll` below are the tests' own way in, so a test
   * says when the background ran.
   */
  const wakes: BackgroundKind[] = [];

  const building = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      TestDatabaseModule.with(database),
      SharedModule.forTesting(),
      EngineModule,
      AiModule,
      // Before `OverlayModule`, which binds the collector that reads its settings.
      DeliveryModule,
      OverlayModule,
      AccountsModule,
      IngotsModule,
      RecordsModule,
      // Both halves: the global one binds the queue, the parser and the worker,
      // and the other binds the command `world.file` dispatches.
      FileStoreModule,
      FilesModule,
      QueryModule,
    ],
  });

  building.overrideProvider(BackgroundWork).useValue({
    wakeEmbeddings: () => wakes.push(BackgroundKind.Embeddings),
    wakeReceipts: () => wakes.push(BackgroundKind.Receipts),
    wakeDeliveries: () => wakes.push(BackgroundKind.Deliveries),
    wakeFiles: () => wakes.push(BackgroundKind.Files),
    settled: async () => undefined,
  } as unknown as BackgroundWork);

  if (overrides.summariser) {
    building.overrideProvider(SUMMARISER).useValue(overrides.summariser);
  }
  if (overrides.transport) {
    building.overrideProvider(DELIVERY_TRANSPORT).useValue(overrides.transport);
  }

  const app = await building.compile();
  await app.init();

  const dispatcher = app.get(Dispatcher);
  // A slug unique per world, since several test files share one database and
  // the truncate between them does not help a world built inside another's run.
  accounts += 1;
  const slug = `acct-${accounts}-${Math.abs(hash(dataDir)) % 9973}`;
  const created = await dispatcher.send(new CreateAccount(slug, 'Test account'));

  const world: World = {
    app,
    dispatcher,
    accountId: created.account.id,
    accountSlug: created.account.slug,
    dataDir,
    wakes,

    async ingot(name = 'a memory') {
      const summary = await dispatcher.send(new CreateIngot(created.account.id, name));
      return summary.id;
    },

    async add(ingotId, body) {
      return dispatcher.send(new AddRecords(ingotId, created.account.id, body));
    },

    async file(ingotId, upload, body = {}) {
      return dispatcher.send(
        new AcceptFile(
          ingotId,
          created.account.id,
          {
            filename: upload.filename,
            mediaType: upload.mediaType,
            content:
              typeof upload.content === 'string' ? Buffer.from(upload.content) : upload.content,
          },
          body,
        ),
      );
    },

    // The worker directly, never through the dispatcher, for the reason the
    // other three are: it is three transactions with a parse in the middle,
    // and dispatching it would put all three back inside the transaction the
    // split exists to avoid.
    async parseAll() {
      let total = 0;
      // Bounded rather than `for(;;)`: a document that keeps failing stays in
      // the queue until it runs out of attempts, and an unbounded loop over one
      // would hang the suite instead of failing it.
      for (let pass = 0; pass < 100; pass++) {
        const found = await app.get(FileWorker, { strict: false }).next();
        if (!found) return total;
        total += 1;
      }
      return total;
    },

    async query(ingotId, body) {
      return dispatcher.ask(new QueryIngot(ingotId, created.account.id, body));
    },

    async sql(ingotId, statement) {
      const result: QueryResult = await dispatcher.ask(
        new QueryIngot(ingotId, created.account.id, { sql: statement }),
      );
      return result.rows;
    },

    async info(ingotId) {
      return dispatcher.ask(new GetIngotInfo(ingotId, created.account.id, created.account.slug));
    },

    async configure(ingotId, table, body) {
      return dispatcher.send(new ConfigureTable(ingotId, created.account.id, table, body));
    },

    async destroy(ingotId) {
      await dispatcher.send(new DeleteIngot(ingotId, created.account.id));
    },

    async configureIngot(ingotId, body) {
      return dispatcher.send(new ConfigureIngot(ingotId, created.account.id, body));
    },

    async forget(ingotId, table, where) {
      const result = await dispatcher.send(
        new DeleteRecords(ingotId, created.account.id, { table, where }),
      );
      return result.rowsForgotten;
    },

    // The workers directly, never through the dispatcher. Each is three
    // transactions with a model call between them, and dispatching one would
    // put all three back inside the transaction the split exists to avoid —
    // `PgUnitOfWork.run` joins an open scope rather than nesting.
    async embedAll() {
      let total = 0;
      for (;;) {
        const done = await app.get(EmbedWorker, { strict: false }).next(256);
        total += done;
        if (done === 0) return total;
      }
    },

    async summariseAll() {
      let total = 0;
      // Bounded rather than `for(;;)`: a receipt that keeps failing stays in the
      // queue until it runs out of attempts, and an unbounded loop over one
      // would hang the suite instead of failing it.
      for (let pass = 0; pass < 100; pass++) {
        const found = await app.get(ReceiptWorker, { strict: false }).next();
        if (!found) return total;
        total += 1;
      }
      return total;
    },

    async deliverAll() {
      let total = 0;
      // Bounded for the same reason: a delivery to a receiver that keeps
      // refusing stays in the outbox until it runs out of attempts, and its
      // lease is cleared on failure — so an unbounded loop would send the same
      // row for ever rather than failing the test.
      for (let pass = 0; pass < 100; pass++) {
        const found = await app.get(DeliveryWorker, { strict: false }).next();
        if (!found) return total;
        total += 1;
      }
      return total;
    },

    /** Forces a roll-up, which the sweeper would otherwise do on a schedule. */
    async compact(ingotId, table) {
      const tables = app.get<IngotTableRepository>(INGOT_TABLE_REPOSITORY, { strict: false });
      const found = await tables.findByName(ingotId, table);
      if (!found) throw new Error(`No table "${table}" to compact`);
      await dispatcher.send(new CompactTable(found.id.value));
    },

    async close() {
      await app.close();
    },
  };

  return world;
}

function hash(value: string): number {
  let out = 0;
  for (let at = 0; at < value.length; at++) out = (Math.imul(out, 31) + value.charCodeAt(at)) | 0;
  return out;
}
