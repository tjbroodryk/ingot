import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ParquetFile } from '../../src/engine/analytical-engine.port.js';
import { type EnvSource, loadSection } from '../../src/config/env.js';
import { parquetCacheEnv } from '../../src/engine/engine-settings.js';
import { ParquetCache } from '../../src/engine/parquet-cache.js';
import type { ObjectStore } from '../../src/storage/object-store.port.js';

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

describe('the parquet cache', () => {
  let dir: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ingot-cache-test-'));
    clock = 1_000_000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function started(objects: Record<string, string>, maxBytes = 100, maxAgeMs = HOUR) {
    const fake = fakeStore(objects);
    const cache = new ParquetCache({ dir, maxBytes, maxAgeMs }, fake.store, now);
    await cache.start();
    return { cache, ...fake };
  }

  it('downloads a file once and serves it locally after that', async () => {
    const { cache, opened } = await started({ a: 'aaaaaaaaaa' });
    const first = await cache.lease([file('a', 10)]);
    const path = first.path('gs://bucket/a');
    first.release();

    expect(path).not.toBe('gs://bucket/a');
    expect(readFileSync(path, 'utf8')).toBe('aaaaaaaaaa');

    const second = await cache.lease([file('a', 10)]);
    expect(second.path('gs://bucket/a')).toBe(path);
    second.release();
    expect(opened).toEqual(['a']);
    cache.stop();
  });

  it('downloads once for concurrent misses on the same file', async () => {
    const { cache, opened } = await started({ a: 'aaaaaaaaaa' });
    const leases = await Promise.all([1, 2, 3].map(() => cache.lease([file('a', 10)])));
    expect(new Set(leases.map((lease) => lease.path('gs://bucket/a'))).size).toBe(1);
    expect(opened).toEqual(['a']);
    cache.stop();
  });

  // The reason the key is not just the object key: a table dropped and made
  // again under the same name counts generations from one, so the same key can
  // name different bytes.
  it('keeps two tables apart even when their object keys match', async () => {
    const { cache, opened } = await started({ a: 'aaaaaaaaaa' });
    // Same derived id, created again later.
    const old = await cache.lease([file('a', 10, 'tbl_1@2026-09-21T10:00:00.000Z')]);
    const recreated = await cache.lease([file('a', 10, 'tbl_1@2026-09-21T10:05:00.000Z')]);
    expect(recreated.path('gs://bucket/a')).not.toBe(old.path('gs://bucket/a'));
    expect(opened).toEqual(['a', 'a']);
    cache.stop();
  });

  it('never goes past its budget, evicting the least recently used', async () => {
    const { cache, opened } = await started(
      {
        a: 'a'.repeat(20),
        b: 'b'.repeat(20),
        c: 'c'.repeat(20),
        d: 'd'.repeat(20),
        e: 'e'.repeat(20),
        f: 'f'.repeat(20),
      },
      100,
    );
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      clock += 1;
      (await cache.lease([file(key, 20)])).release();
    }
    expect(cache.bytes).toBe(100);

    // Touch `a`, so `b` is now the oldest.
    clock += 1;
    (await cache.lease([file('a', 20)])).release();
    clock += 1;
    (await cache.lease([file('f', 20)])).release();
    expect(cache.bytes).toBe(100);

    opened.length = 0;
    (await cache.lease([file('a', 20)])).release();
    (await cache.lease([file('b', 20)])).release();
    expect(opened).toEqual(['b']);
    cache.stop();
  });

  it('does not evict a file a session is reading, and reads remotely instead', async () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const { cache } = await started(Object.fromEntries(keys.map((key) => [key, key.repeat(25)])));
    const holding = await cache.lease(keys.slice(0, 4).map((key) => file(key, 25)));
    const next = await cache.lease([file('e', 25)]);

    expect(next.path('gs://bucket/e')).toBe('gs://bucket/e');
    for (const key of keys.slice(0, 4)) {
      expect(existsSync(holding.path(`gs://bucket/${key}`))).toBe(true);
    }
    expect(cache.bytes).toBe(100);
    holding.release();
    cache.stop();
  });

  it('reads a file bigger than a quarter of the budget from the store', async () => {
    const { cache, opened } = await started({ big: 'x'.repeat(30) }, 100);
    const lease = await cache.lease([file('big', 30)]);
    expect(lease.path('gs://bucket/big')).toBe('gs://bucket/big');
    expect(opened).toEqual([]);
    cache.stop();
  });

  it('sizes a file after the download when the manifest did not know it', async () => {
    const { cache } = await started({ a: 'a'.repeat(12) });
    const lease = await cache.lease([file('a', 0)]);
    expect(lease.path('gs://bucket/a')).not.toBe('gs://bucket/a');
    expect(cache.bytes).toBe(12);
    cache.stop();
  });

  it('removes a file past its age, and fetches it again if asked', async () => {
    const { cache, opened } = await started({ a: 'aaaaaaaaaa' });
    const lease = await cache.lease([file('a', 10)]);
    const path = lease.path('gs://bucket/a');
    lease.release();

    clock += HOUR;
    cache.expire();
    await Bun.sleep(5);
    expect(existsSync(path)).toBe(false);
    expect(cache.bytes).toBe(0);

    (await cache.lease([file('a', 10)])).release();
    expect(opened).toEqual(['a', 'a']);
    cache.stop();
  });

  it('keeps an expired file until the session reading it lets go', async () => {
    const { cache } = await started({ a: 'aaaaaaaaaa' });
    const lease = await cache.lease([file('a', 10)]);
    const path = lease.path('gs://bucket/a');

    clock += HOUR;
    cache.expire();
    await Bun.sleep(5);
    expect(existsSync(path)).toBe(true);

    lease.release();
    await Bun.sleep(5);
    expect(existsSync(path)).toBe(false);
    expect(cache.bytes).toBe(0);
    cache.stop();
  });

  it('falls back to the store when a download fails, and gives the room back', async () => {
    const { cache, fail } = await started({ a: 'aaaaaaaaaa' });
    fail();
    const lease = await cache.lease([file('a', 10)]);
    expect(lease.path('gs://bucket/a')).toBe('gs://bucket/a');
    expect(cache.bytes).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    cache.stop();
  });

  it('passes every file through untouched when it is off', async () => {
    const { cache, opened } = await started({ a: 'aaaaaaaaaa' }, 0);
    const lease = await cache.lease([file('a', 10)]);
    expect(lease.path('gs://bucket/a')).toBe('gs://bucket/a');
    expect(opened).toEqual([]);
  });

  it('empties its own files at start, and nothing else in the directory', async () => {
    writeFileSync(join(dir, 'pc-leftover.parquet'), 'old');
    writeFileSync(join(dir, 'staging.parquet'), 'not ours');
    const { cache } = await started({});
    expect(readdirSync(dir)).toEqual(['staging.parquet']);
    cache.stop();
  });
});

describe('parquet cache settings', () => {
  const read = (values: Record<string, string>) => values;
  const parquetCacheSettings = (source: EnvSource) => loadSection(parquetCacheEnv, source);

  it('is off unless given a budget', () => {
    expect(parquetCacheSettings(read({})).maxBytes).toBe(0);
  });

  it('takes a byte count, a quantity, or what Helm makes of a large number', () => {
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
