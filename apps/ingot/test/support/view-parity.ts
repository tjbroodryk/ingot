import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import type { QueryBody } from '@ingot/shared/ingot-v1';
import { registry } from '../../src/observability/metrics/registry.js';
import { FilesystemObjectStore } from '../../src/storage/filesystem-object-store.js';
import { closeDatabase } from './database.js';
import { ParityEngine, ParityMismatch } from './parity-engine.js';
import { type World, makeWorld } from './world.js';

/**
 * A query reading Parquet through a view must answer exactly as one that
 * copies it in. Roll-ups always copy, so if the two drift, the same question
 * gets a different answer either side of a roll-up.
 *
 * Every question below goes through `ParityEngine`, which asks both and throws
 * on any difference, refusals included. The steps walk a table through the
 * states that make a view differ from a copy: rows in both tiers, forgotten
 * rows in both, a column the Parquet predates, and vectors from both the
 * sibling file and the overlay.
 *
 * The test files own `describe` and the hooks, one composition each: hooks
 * registered from here leak into other files, and each world truncates the
 * database.
 */
export interface ViewParity {
  open(): Promise<void>;
  close(): Promise<void>;
  readonly steps: ReadonlyArray<readonly [string, () => Promise<void>]>;
}

// Not local, so a view can only come from the Parquet cache.
class BucketLikeStore extends FilesystemObjectStore {
  override readonly local = false;
}

const events = (from: number, count: number, widened = false) => ({
  table: 'events',
  rows: '$.items[*]',
  key: ['n'],
  columns: {
    n: { from: '$.n', type: ColumnType.Integer },
    kind: { from: '$.kind', type: ColumnType.Varchar },
    at: { from: '$.at', type: ColumnType.Timestamp },
    amount: { from: '$.amount', type: ColumnType.Double },
    note: { from: '$.note', type: ColumnType.Varchar, embed: true },
    ...(widened ? { extra: { from: '$.extra', type: ColumnType.Varchar } } : {}),
  },
  result: {
    items: Array.from({ length: count }, (_, index) => {
      const n = from + index;
      return {
        n,
        kind: n % 3 === 0 ? 'error' : 'info',
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
        amount: n * 1.5,
        note: `event number ${n} ${n % 2 === 0 ? 'a broken migration' : 'a passing build'}`,
        ...(widened ? { extra: `extra ${n}` } : {}),
      };
    }),
  },
});

const questions: readonly QueryBody[] = [
  { sql: 'SELECT count(*) AS n FROM events' },
  { sql: 'SELECT n, kind, "at", amount, note FROM events ORDER BY n' },
  { sql: 'SELECT * FROM events ORDER BY n' },
  { sql: 'SELECT n, extra FROM events ORDER BY n' },
  {
    sql: 'SELECT kind, count(*) AS n, sum(amount) AS total FROM events GROUP BY kind ORDER BY kind',
  },
  { sql: `SELECT n FROM events WHERE "at" > TIMESTAMP '2026-01-01 00:00:10' ORDER BY n` },
  { sql: 'SELECT n FROM events WHERE note_vec IS NOT NULL ORDER BY n' },
  { sql: 'SELECT count(*) AS n FROM events WHERE note_vec IS NULL' },
  { sql: 'SELECT a.n FROM events a JOIN events b ON a.n = b.n + 1 ORDER BY a.n' },
  {
    sql:
      "WITH errors AS (SELECT * FROM events WHERE kind = 'error') " +
      'SELECT count(*) AS n, min(n) AS first FROM errors',
  },
  { sql: "SELECT n, json_extract_string(_raw, '$.kind') AS kind FROM events ORDER BY n" },
  { sql: 'SELECT count(DISTINCT _row_id) AS n, count(DISTINCT _batch) AS batches FROM events' },
  {
    sql:
      'SELECT column_name, data_type FROM information_schema.columns ' +
      "WHERE table_name = 'events' ORDER BY column_name",
  },
  {
    text: 'a broken migration',
    sql:
      'SELECT n FROM events WHERE note_vec IS NOT NULL ' +
      'ORDER BY array_cosine_similarity(note_vec, $q) DESC, n LIMIT 5',
  },
  { text: 'a broken migration', table: 'events' },
  // Fails on the data, and must fail the same way.
  { sql: 'SELECT CAST(kind AS INTEGER) FROM events' },
  { sql: 'SELECT n FROM events ORDER BY n', limit: 3 },
];

const viewsBuilt = async (): Promise<number> => {
  const scrape = await registry().getSingleMetricAsString('ingot_session_tables_total');
  return Number(/mode="view"\} (\d+)/.exec(scrape)?.[1] ?? 0);
};

export function viewParity({ cache }: { cache: boolean }): ViewParity {
  let world: World;
  let ingot: string;
  let engine: ParityEngine;
  let cacheDir: string | undefined;

  /** Every question, through both engines; a refusal both agree on is fine. */
  const agree = async (): Promise<void> => {
    for (const question of questions) {
      await world.query(ingot, question).catch((error: unknown) => {
        if (error instanceof ParityMismatch) throw error;
      });
    }
  };

  return {
    async open() {
      cacheDir = cache ? mkdtempSync(join(tmpdir(), 'ingot-parity-cache-')) : undefined;
      world = await makeWorld({
        ...(cache
          ? {
              store: (dataDir: string) => new BucketLikeStore(dataDir),
              env: {
                INGOT_PARQUET_CACHE_BYTES: String(64 * 1024 * 1024),
                INGOT_PARQUET_CACHE_DIR: cacheDir as string,
              },
            }
          : {}),
        engine: (store, env, parquetCache) => {
          engine = new ParityEngine(store, env, parquetCache);
          return engine;
        },
      });
      ingot = await world.ingot('parity');
    },

    async close() {
      await world?.close();
      if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
      await closeDatabase();
    },

    steps: [
      [
        'agree with every row in the overlay',
        async () => {
          await world.add(ingot, events(0, 20));
          await world.embedAll();
          await agree();
        },
      ],
      [
        'agree once the rows are in Parquet, and build views to do it',
        async () => {
          await world.compact(ingot, 'events');
          const before = await viewsBuilt();
          await agree();
          expect(await viewsBuilt()).toBeGreaterThan(before);
        },
      ],
      [
        'agree with rows in both tiers',
        async () => {
          await world.add(ingot, events(20, 10));
          await world.embedAll();
          await agree();
        },
      ],
      [
        'agree on what was forgotten, in either tier',
        async () => {
          expect(await world.forget(ingot, 'events', 'n < 3 OR n = 25')).toBe(4);
          await agree();
        },
      ],
      [
        'agree on a column the Parquet predates',
        async () => {
          await world.add(ingot, events(30, 5, true));
          await world.compact(ingot, 'events');
          await world.add(ingot, events(35, 5, true));
          await agree();
        },
      ],
      [
        'agree on vectors from the sibling file and from the overlay together',
        async () => {
          // Rolled up before they were embedded: their vectors land in the
          // overlay while the rows themselves are in Parquet.
          await world.add(ingot, events(40, 5, true));
          await world.compact(ingot, 'events');
          await world.embedAll();
          await agree();

          const embedded = await world.sql(
            ingot,
            'SELECT count(*) AS n FROM events WHERE note_vec IS NOT NULL',
          );
          expect(Number(embedded[0]?.n)).toBe(41);
        },
      ],
      [
        'agree on what a delete resolves its predicate to',
        async () => {
          expect(await world.forget(ingot, 'events', "kind = 'error' AND n > 40")).toBe(1);
          await agree();
        },
      ],
      [
        'compared every question at every step',
        async () => {
          expect(engine.compared).toBeGreaterThan(questions.length * 6);
        },
      ],
    ],
  };
}
