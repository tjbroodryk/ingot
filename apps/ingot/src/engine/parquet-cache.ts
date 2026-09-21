import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Logger } from '@nestjs/common';
import { CacheResult, EvictionReason, Metrics, observe } from '../observability/index.js';
import type { ObjectStore } from '../storage/object-store.port.js';
import type { MaterialisableTable, ParquetFile } from './analytical-engine.port.js';
import type { CachedFileUse, EvictedFile, ParquetCacheIndex } from './parquet-cache-index.port.js';

export interface ParquetCacheSettings {
  /** A directory every replica mounts. */
  readonly dir: string;
  /** The budget, across every replica. 0 turns the cache off. */
  readonly maxBytes: number;
  /** How long a file may stay once cached, however often it is read. */
  readonly maxAgeMs: number;
}

/** Where a session reads each of its files from. */
export class Lease {
  /** Every file from the store: a roll-up, or the retry after a cached read failed. */
  static readonly none = new Lease(new Map());

  constructor(private readonly cached: ReadonlyMap<string, string>) {}

  /** Whether any file resolved to a cached copy. */
  get local(): boolean {
    return this.cached.size > 0;
  }

  /** The cached copy of `uri` when there is one, `uri` itself when there is not. */
  path(uri: string): string {
    return this.cached.get(uri) ?? uri;
  }

  /** The table with every object the cache holds pointed at its local copy. */
  apply(table: MaterialisableTable): MaterialisableTable {
    return {
      ...table,
      baseFiles: table.baseFiles.map((uri) => this.path(uri)),
      vectorFiles: table.vectorFiles.map((uri) => this.path(uri)),
    };
  }

  /** Whether any of these tables' files still has to come from the store. */
  readsStore(tables: readonly MaterialisableTable[]): boolean {
    return tables.some((table) => table.sources.some((file) => !this.cached.has(file.uri)));
  }
}

/** Unread this long before the sweep may delete a file: reads on other replicas aren't tracked. */
export const IDLE_BEFORE_EVICTION_MS = 5 * 60_000;
const FLUSH_EVERY_MS = 30_000;
/** A shared volume that stops answering must not take queries with it. */
const CHECK_TIMEOUT_MS = 2_000;
/** The sweep evicts down to this share of the budget, so misses have room. */
const SWEEP_TARGET = 0.9;
const PREFIX = 'pc-';

/**
 * Caches base-tier Parquet on a volume shared by every replica, so a query
 * reads a swept table from disk instead of the bucket. Usage is tracked in
 * `ParquetCacheIndex`; `sweep` evicts. Any failure falls back to the bucket.
 */
export class ParquetCache {
  private readonly logger = new Logger(ParquetCache.name);
  private readonly fetching = new Map<string, Promise<number | null>>();
  private readonly uses = new Map<string, CachedFileUse>();
  /** The shared total as of the last flush, plus what this replica added since. */
  private estimate = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly settings: ParquetCacheSettings,
    private readonly store: ObjectStore,
    private readonly index: ParquetCacheIndex,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.settings.maxBytes > 0;
  }

  /** Never empties the directory: other replicas are reading it. The sweep tidies. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.settings.dir, { recursive: true });
    this.estimate = await this.index.totalBytes();
    Metrics.ParquetCacheSize.collectWith((gauge) => gauge.set({}, this.estimate));
    this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  async lease(files: readonly ParquetFile[]): Promise<Lease> {
    const local = new Map<string, string>();
    await Promise.all(
      files.map(async (file) => {
        const path = await this.resolve(file);
        if (path) local.set(file.uri, path);
      }),
    );
    return new Lease(local);
  }

  /** For a deleted table or ingot: the next sweep past the idle wait deletes it all. */
  async forgetPrefix(prefix: string): Promise<void> {
    if (!this.enabled) return;
    await this.index.expirePrefix(prefix);
  }

  /** Records this replica's reads, and learns the shared total. */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    const batch = [...this.uses.values()];
    this.uses.clear();
    try {
      await this.index.touch(batch);
      this.estimate = await this.index.totalBytes();
    } catch (error) {
      // Put back rather than lose: a read that never reaches the index is a
      // file the sweep may think idle.
      for (const use of batch) if (!this.uses.has(use.id)) this.uses.set(use.id, use);
      this.logger.warn(`Could not record Parquet cache reads: ${String(error)}`);
    }
  }

  /**
   * Deletes what is past its age or beyond the budget, and what the index has
   * no row for. For one replica at a time: the roll-up sweeper's lock.
   */
  async sweep(): Promise<void> {
    if (!this.enabled) return;
    await this.flush();
    const now = this.now();
    const idleBefore = new Date(now - IDLE_BEFORE_EVICTION_MS);

    const expired = await this.index.evictExpired(
      new Date(now - this.settings.maxAgeMs),
      idleBefore,
    );
    await this.discard(expired, EvictionReason.Age);

    const target = Math.floor(this.settings.maxBytes * SWEEP_TARGET);
    await this.discard(await this.index.evictDownTo(target, idleBefore), EvictionReason.Lru);

    await this.removeOrphans(idleBefore);
    this.estimate = await this.index.totalBytes();
  }

  /** A path to the cached copy, or null to read the file from the store. */
  private async resolve(file: ParquetFile): Promise<string | null> {
    if (!this.enabled || file.bytes > this.ceiling) {
      Metrics.ParquetCacheRequests.inc({ result: CacheResult.Bypass });
      return null;
    }

    const id = cacheId(file);
    const path = join(this.settings.dir, `${PREFIX}${id}.parquet`);
    try {
      const found = await within(
        CHECK_TIMEOUT_MS,
        stat(path).catch(() => null),
      );
      if (found) {
        // The file's own time, so the age is right whichever replica landed it.
        this.record(id, file.key, found.size, found.mtime);
        Metrics.ParquetCacheRequests.inc({ result: CacheResult.Hit });
        return path;
      }

      let pending = this.fetching.get(id);
      if (!pending) {
        pending = this.fetch(file, path).finally(() => this.fetching.delete(id));
        this.fetching.set(id, pending);
      }
      const size = await pending;
      if (size === null) {
        Metrics.ParquetCacheRequests.inc({ result: CacheResult.Bypass });
        return null;
      }
      this.record(id, file.key, size, new Date(this.now()));
      Metrics.ParquetCacheRequests.inc({ result: CacheResult.Miss });
      return path;
    } catch (error) {
      this.logger.warn(`The Parquet cache did not answer for ${file.key}: ${String(error)}`);
      Metrics.ParquetCacheRequests.inc({ result: CacheResult.Bypass });
      return null;
    }
  }

  /** Downloads into place and returns the size, or null when it should not be cached. */
  private async fetch(file: ParquetFile, path: string): Promise<number | null> {
    // Against the shared total as last seen; the sweep puts right an overshoot.
    if (file.bytes > 0 && this.estimate + file.bytes > this.settings.maxBytes) return null;

    // Unique per attempt, so two replicas downloading the same file at once
    // never write into each other's half.
    const partial = `${path}.${randomBytes(4).toString('hex')}.partial`;
    try {
      await observe('ingot.parquet_cache_fetch', { 'ingot.bytes': file.bytes }, async () => {
        const source = await this.store.open(file.key);
        await pipeline(source, createWriteStream(partial, { flags: 'wx' }));
      });
      const { size } = await stat(partial);
      if (size > this.ceiling || this.estimate + size > this.settings.maxBytes) {
        await rm(partial, { force: true });
        return null;
      }
      // Atomic, and the bytes are the same whichever replica's rename lands last.
      await rename(partial, path);
      this.estimate += size;
      return size;
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      this.logger.warn(`Could not cache ${file.key}; reading it from the store: ${String(error)}`);
      return null;
    }
  }

  private record(id: string, objectKey: string, bytes: number, cachedAt: Date): void {
    this.uses.set(id, { id, objectKey, bytes, cachedAt, usedAt: new Date(this.now()) });
  }

  private async discard(files: readonly EvictedFile[], reason: EvictionReason): Promise<void> {
    for (const file of files) {
      await rm(join(this.settings.dir, `${PREFIX}${file.id}.parquet`), { force: true }).catch(
        (error: unknown) =>
          this.logger.warn(`Could not remove cached ${file.id}: ${String(error)}`),
      );
      Metrics.ParquetCacheEvictions.inc({ reason });
    }
  }

  /**
   * Files with no row, and unfinished downloads. Only idle ones: a fresh file
   * has no row until its replica flushes.
   */
  private async removeOrphans(idleBefore: Date): Promise<void> {
    const names = (await readdir(this.settings.dir)).filter((name) => name.startsWith(PREFIX));
    const stale: string[] = [];
    for (const name of names) {
      const info = await stat(join(this.settings.dir, name)).catch(() => null);
      if (info && info.mtime < idleBefore) stale.push(name);
    }

    const byId = new Map<string, string>();
    for (const name of stale) {
      if (name.endsWith('.partial')) {
        await rm(join(this.settings.dir, name), { force: true });
      } else {
        byId.set(name.slice(PREFIX.length, -'.parquet'.length), name);
      }
    }
    const known = await this.index.known([...byId.keys()]);
    for (const [id, name] of byId) {
      if (!known.has(id)) await rm(join(this.settings.dir, name), { force: true });
    }
  }

  private get ceiling(): number {
    return this.settings.maxBytes / 4;
  }
}

// Includes the table's life, not just the key: a recreated table reuses its keys.
function cacheId(file: ParquetFile): string {
  return createHash('sha256').update(`${file.table}\0${file.key}`).digest('hex').slice(0, 32);
}

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
