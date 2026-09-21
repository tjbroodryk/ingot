import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ParquetFile } from '../../src/engine/analytical-engine.port.js';
import { type EnvSource, loadSection } from '../../src/config/env.js';
import { parquetCacheEnv } from '../../src/engine/engine-settings.js';
import type {
  CachedFileUse,
  EvictedFile,
  ParquetCacheIndex,
} from '../../src/engine/parquet-cache-index.port.js';
import { IDLE_BEFORE_EVICTION_MS, ParquetCache } from '../../src/engine/parquet-cache.js';
import type { ObjectStore } from '../../src/storage/object-store.port.js';

/** The index as the port describes it, in memory. The SQL is tested against Postgres. */
class MemoryIndex implements ParquetCacheIndex {
  readonly rows = new Map<string, { -readonly [K in keyof CachedFileUse]: CachedFileUse[K] }>();

  async touch(uses: readonly CachedFileUse[]): Promise<void> {
    for (const use of uses) {
      const row = this.rows.get(use.id);
      if (!row) this.rows.set(use.id, { ...use });
      else if (use.usedAt > row.usedAt) this.rows.set(use.id, { ...row, usedAt: use.usedAt });
    }
  }

  async totalBytes(): Promise<number> {
    return [...this.rows.values()].reduce((sum, row) => sum + row.bytes, 0);
  }

  async expirePrefix(prefix: string): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.objectKey.startsWith(`${prefix}/`)) row.cachedAt = new Date(0);
    }
  }

  async evictExpired(cachedBefore: Date, idleBefore: Date): Promise<readonly EvictedFile[]> {
    return this.take(
      [...this.rows.values()].filter(
        (row) => row.cachedAt < cachedBefore && row.usedAt < idleBefore,
      ),
    );
  }

  async evictDownTo(bytes: number, idleBefore: Date): Promise<readonly EvictedFile[]> {
    let excess = (await this.totalBytes()) - bytes;
    const chosen = [];
    for (const row of [...this.rows.values()]
      .filter((row) => row.usedAt < idleBefore)
      .sort((a, b) => a.usedAt.getTime() - b.usedAt.getTime())) {
      if (excess <= 0) break;
      chosen.push(row);
      excess -= row.bytes;
    }
    return this.take(chosen);
  }

  async known(ids: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(ids.filter((id) => this.rows.has(id)));
  }

  private take(rows: readonly CachedFileUse[]): EvictedFile[] {
    for (const row of rows) this.rows.delete(row.id);
    return rows.map((row) => ({ id: row.id, bytes: row.bytes }));
  }
}

/** A store whose objects are strings, which counts what it was asked for. */
function fakeStore(objects: Record<string, string>) {
  const opened: string[] = [];
  let failing = false;
  const store = {
    async open(key: string) {
      opened.push(key);
      if (failing) throw new Error('bucket unreachable');
      const body = objects[key];
      if (body === undefined) throw new Error(`no object ${key}`);
      return Readable.from([Buffer.from(body)]);
    },
  } as unknown as ObjectStore;
  return {
    store,
    opened,
    fail: () => {
      failing = true;
    },
  };
}

function file(key: string, bytes: number, table = 'tbl_1@2026-09-21T00:00:00.000Z'): ParquetFile {
  return { table, key, uri: `gs://bucket/${key}`, bytes };
}

const HOUR = 3_600_000;

describe('the shared parquet cache', () => {
  let dir: string;
  let clock: number;
  let index: MemoryIndex;
  const now = () => clock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ingot-cache-test-'));
    clock = Date.now();
    index = new MemoryIndex();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** One replica. Several made in one test share the directory and the index, as pods do. */
  async function replica(
    objects: Record<string, string>,
    options: { maxBytes?: number; maxAgeMs?: number } = {},
  ) {
    const fake = fakeStore(objects);
    const cache = new ParquetCache(
      { dir, maxBytes: options.maxBytes ?? 100, maxAgeMs: options.maxAgeMs ?? HOUR },
      fake.store,
      index,
      now,
    );
    await cache.start();
    return { cache, ...fake };
  }

  const cachedFiles = () => readdirSync(dir).filter((name) => name.endsWith('.parquet'));

  it('downloads a file once and serves it from the volume after that', async () => {
    const { cache, opened } = await replica({ a: 'aaaaaaaaaa' });
    const first = await cache.lease([file('a', 10)]);
    const second = await cache.lease([file('a', 10)]);

    expect(first.local).toBe(true);
    expect(second.path('gs://bucket/a')).toBe(first.path('gs://bucket/a'));
    expect(opened).toEqual(['a']);
    await cache.stop();
  });

  // The point of sharing the volume: one copy, whichever replica fetched it.
  it('serves one replica the file another downloaded', async () => {
    const one = await replica({ a: 'aaaaaaaaaa' });
    const two = await replica({ a: 'aaaaaaaaaa' });

    const fetched = await one.cache.lease([file('a', 10)]);
    const found = await two.cache.lease([file('a', 10)]);

    expect(found.path('gs://bucket/a')).toBe(fetched.path('gs://bucket/a'));
    expect(one.opened).toEqual(['a']);
    expect(two.opened).toEqual([]);
    expect(cachedFiles()).toHaveLength(1);
    await one.cache.stop();
    await two.cache.stop();
  });

  it('downloads once for concurrent misses in one replica', async () => {
    const { cache, opened } = await replica({ a: 'aaaaaaaaaa' });
    await Promise.all([1, 2, 3].map(() => cache.lease([file('a', 10)])));
    expect(opened).toEqual(['a']);
    await cache.stop();
  });

  // A table dropped and made again under the same name has the same derived id
  // and counts generations from one, so the same key can name different bytes.
  it('keeps two lives of one table apart even when their object keys match', async () => {
    const { cache, opened } = await replica({ a: 'aaaaaaaaaa' });
    const old = await cache.lease([file('a', 10, 'tbl_1@2026-09-21T10:00:00.000Z')]);
    const recreated = await cache.lease([file('a', 10, 'tbl_1@2026-09-21T10:05:00.000Z')]);
    expect(recreated.path('gs://bucket/a')).not.toBe(old.path('gs://bucket/a'));
    expect(opened).toEqual(['a', 'a']);
    await cache.stop();
  });

  it('reads a file bigger than a quarter of the budget from the store', async () => {
    const { cache, opened } = await replica({ big: 'x'.repeat(30) });
    const lease = await cache.lease([file('big', 30)]);
    expect(lease.local).toBe(false);
    expect(opened).toEqual([]);
    await cache.stop();
  });

  it('reads from the store rather than download past the shared budget', async () => {
    const { cache, opened } = await replica(
      Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((key) => [key, key.repeat(25)])),
    );
    for (const key of ['a', 'b', 'c', 'd']) await cache.lease([file(key, 25)]);
    const full = await cache.lease([file('e', 25)]);

    expect(full.local).toBe(false);
    expect(opened).toEqual(['a', 'b', 'c', 'd']);
    await cache.stop();
  });

  it('falls back to the store when a download fails, leaving nothing behind', async () => {
    const { cache, fail } = await replica({ a: 'aaaaaaaaaa' });
    fail();
    const lease = await cache.lease([file('a', 10)]);
    expect(lease.local).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    await cache.stop();
  });

  it('passes every file through untouched when it is off', async () => {
    const { cache, opened } = await replica({ a: 'aaaaaaaaaa' }, { maxBytes: 0 });
    const lease = await cache.lease([file('a', 10)]);
    expect(lease.path('gs://bucket/a')).toBe('gs://bucket/a');
    expect(opened).toEqual([]);
  });

  it('leaves what other replicas cached alone when it starts', async () => {
    writeFileSync(join(dir, 'pc-somebody-elses.parquet'), 'theirs');
    const { cache } = await replica({});
    expect(cachedFiles()).toEqual(['pc-somebody-elses.parquet']);
    await cache.stop();
  });

  it('records reads in the index, in batches', async () => {
    const { cache } = await replica({ a: 'aaaaaaaaaa' });
    await cache.lease([file('a', 10)]);
    expect(index.rows.size).toBe(0);
    await cache.flush();
    expect([...index.rows.values()].map((row) => [row.objectKey, row.bytes])).toEqual([['a', 10]]);
    await cache.stop();
  });

  describe('the sweep', () => {
    it('deletes what is past its age, once nobody has read it for a while', async () => {
      const { cache } = await replica({ a: 'aaaaaaaaaa' });
      await cache.lease([file('a', 10)]);

      clock += HOUR;
      // Past its age, but read a moment ago: another replica may be reading it.
      await cache.lease([file('a', 10)]);
      await cache.sweep();
      expect(cachedFiles()).toHaveLength(1);

      clock += IDLE_BEFORE_EVICTION_MS + 1;
      await cache.sweep();
      expect(cachedFiles()).toEqual([]);
      expect(index.rows.size).toBe(0);
      await cache.stop();
    });

    it('evicts the least recently read until the total is back under the budget', async () => {
      const keys = ['a', 'b', 'c', 'd'];
      const { cache } = await replica(Object.fromEntries(keys.map((key) => [key, key.repeat(25)])));
      for (const key of keys) {
        clock += 1_000;
        await cache.lease([file(key, 25)]);
      }
      // Read `a` again, so `b` is the oldest.
      clock += 1_000;
      await cache.lease([file('a', 25)]);

      clock += IDLE_BEFORE_EVICTION_MS + 1;
      await cache.sweep();

      // 100 bytes down to 90 at most: one file goes, and it is `b`.
      const left = [...index.rows.values()].map((row) => row.objectKey).sort();
      expect(left).toEqual(['a', 'c', 'd']);
      expect(cachedFiles()).toHaveLength(3);
      await cache.stop();
    });

    it('deletes a deleted table or ingot’s files on the next sweep past the idle wait', async () => {
      const { cache } = await replica({
        'acct/ing/tables/notes/gen-000001/part-0001.parquet': 'n'.repeat(10),
        'acct/ing/tables/notes2/gen-000001/part-0001.parquet': 'm'.repeat(10),
      });
      await cache.lease([
        file('acct/ing/tables/notes/gen-000001/part-0001.parquet', 10),
        file('acct/ing/tables/notes2/gen-000001/part-0001.parquet', 10),
      ]);
      await cache.flush();

      await cache.forgetPrefix('acct/ing/tables/notes');
      clock += IDLE_BEFORE_EVICTION_MS + 1;
      await cache.sweep();

      expect([...index.rows.values()].map((row) => row.objectKey)).toEqual([
        'acct/ing/tables/notes2/gen-000001/part-0001.parquet',
      ]);
      expect(cachedFiles()).toHaveLength(1);
      await cache.stop();
    });

    it('removes files the index does not know and downloads that never finished, once idle', async () => {
      const { cache } = await replica({});
      const old = new Date(Date.now() - 2 * IDLE_BEFORE_EVICTION_MS);
      for (const name of ['pc-orphan.parquet', 'pc-dead.parquet.abcd.partial']) {
        writeFileSync(join(dir, name), 'x');
        utimesSync(join(dir, name), old, old);
      }
      // Just downloaded by another replica, whose flush has not landed yet.
      writeFileSync(join(dir, 'pc-fresh.parquet'), 'x');

      await cache.sweep();
      expect(readdirSync(dir)).toEqual(['pc-fresh.parquet']);
      await cache.stop();
    });
  });

  it('still answers when its volume has gone', async () => {
    const { cache } = await replica({ a: 'aaaaaaaaaa' });
    rmSync(dir, { recursive: true, force: true });
    const lease = await cache.lease([file('a', 10)]);
    expect(lease.local).toBe(false);
    expect(existsSync(dir)).toBe(false);
    await cache.stop();
  });
});

describe('parquet cache settings', () => {
  const read = (values: Record<string, string>) => values;
  const parquetCacheSettings = (source: EnvSource) => loadSection(parquetCacheEnv, source);

  it('is off unless given a budget', () => {
    expect(parquetCacheSettings(read({})).maxBytes).toBe(0);
  });

  it('takes a byte count, a binary suffix, or exponent notation', () => {
    expect(parquetCacheSettings(read({ INGOT_PARQUET_CACHE_BYTES: '1048576' })).maxBytes).toBe(
      1048576,
    );
    expect(parquetCacheSettings(read({ INGOT_PARQUET_CACHE_BYTES: '2Gi' })).maxBytes).toBe(
      2 * 1024 ** 3,
    );
    expect(
      parquetCacheSettings(read({ INGOT_PARQUET_CACHE_BYTES: '2.147483648e+09' })).maxBytes,
    ).toBe(2 * 1024 ** 3);
    expect(
      parquetCacheSettings(read({ INGOT_PARQUET_CACHE_MAX_AGE_MS: '8.64e+07' })).maxAgeMs,
    ).toBe(86_400_000);
  });

  it('refuses a budget or an age it cannot use', () => {
    for (const bytes of ['-1', 'lots', '2GB', '1.5']) {
      expect(() => parquetCacheSettings(read({ INGOT_PARQUET_CACHE_BYTES: bytes }))).toThrow(
        'INGOT_PARQUET_CACHE_BYTES',
      );
    }
    for (const age of ['1000', '999999999999', 'soon']) {
      expect(() => parquetCacheSettings(read({ INGOT_PARQUET_CACHE_MAX_AGE_MS: age }))).toThrow(
        'INGOT_PARQUET_CACHE_MAX_AGE_MS',
      );
    }
  });
});
