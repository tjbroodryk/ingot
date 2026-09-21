import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Logger } from '@nestjs/common';
import { CacheResult, EvictionReason, Metrics, observe } from '../observability/index.js';
import type { ObjectStore } from '../storage/object-store.port.js';
import type { ParquetFile } from './analytical-engine.port.js';

export interface ParquetCacheSettings {
  readonly dir: string;
  /** The budget. 0 turns the cache off and every file is read from the store. */
  readonly maxBytes: number;
  /** How long a file may stay once cached, however often it is read. */
  readonly maxAgeMs: number;
}

/** Files a session holds open. Paths stay on disk until `release`. */
export interface Lease {
  /** The local copy of `uri` when there is one, `uri` itself when there is not. */
  path(uri: string): string;
  release(): void;
}

interface Entry {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly cachedAt: number;
  lastUsed: number;
  pins: number;
  /** Past its age while pinned: out of the index, deleted on the last release. */
  retired: boolean;
}

/** Every file this cache writes starts with this, so boot only removes its own. */
const PREFIX = 'pc-';

/**
 * Base-tier Parquet, kept on this pod's disk.
 *
 * Every query builds a fresh DuckDB instance, so nothing DuckDB caches itself
 * outlives the query — a swept table is a whole-file read from the bucket, every
 * time. A generation's files are never rewritten once the manifest names them,
 * which is what makes keeping a copy safe.
 *
 * Keyed by the table's life (`ParquetFile.table`) *and* the object key. Keys
 * carry the table's name, and a table dropped and recreated under the same name
 * counts generations from one again, so the key alone would hand the new table
 * the old one's `gen-000001`.
 *
 * Bounded three ways: a byte budget it never writes past (evicting the least
 * recently used first), a per-file ceiling of a quarter of that so one table
 * cannot flush the rest, and a maximum age after which a file goes however often
 * it is read — which is also how long a destroyed ingot's data can outlive its
 * bucket objects here.
 *
 * Nothing in here fails a query. A file that cannot be cached — too big, no
 * room, a download that broke — is read from the store as it was before this
 * existed.
 */
export class ParquetCache {
  private readonly logger = new Logger(ParquetCache.name);
  private readonly entries = new Map<string, Entry>();
  private readonly retiring = new Set<Entry>();
  private readonly fetching = new Map<string, Promise<Entry | null>>();
  /** Every entry, every retiring entry, and every download's reservation. */
  private used = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly settings: ParquetCacheSettings,
    private readonly store: ObjectStore,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.settings.maxBytes > 0;
  }

  /** Bytes held now. For the gauge and for tests. */
  get bytes(): number {
    return this.used;
  }

  /**
   * Empties the directory and starts the age sweep.
   *
   * Emptied rather than re-indexed: the index is in memory, the volume rarely
   * outlives the pod, and a file whose age is unknown is one this cache cannot
   * promise to delete on time.
   */
  async start(): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.settings.dir, { recursive: true });
    for (const name of await readdir(this.settings.dir)) {
      if (name.startsWith(PREFIX)) await rm(join(this.settings.dir, name), { force: true });
    }

    Metrics.ParquetCacheSize.collectWith((gauge) => gauge.set({}, this.used));
    // Often enough that a file never outlives its age by more than a quarter of it.
    const every = Math.min(this.settings.maxAgeMs / 4, 5 * 60_000);
    this.timer = setInterval(() => this.expire(), every);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async lease(files: readonly ParquetFile[]): Promise<Lease> {
    const local = new Map<string, string>();
    const held: Entry[] = [];

    await Promise.all(
      files.map(async (file) => {
        const entry = await this.resolve(file);
        if (entry) {
          held.push(entry);
          local.set(file.uri, entry.path);
        }
      }),
    );

    let released = false;
    return {
      path: (uri) => local.get(uri) ?? uri,
      release: () => {
        if (released) return;
        released = true;
        for (const entry of held) this.unpin(entry);
      },
    };
  }

  /** Removes everything past its age that nobody is reading. */
  expire(): void {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (now - entry.cachedAt >= this.settings.maxAgeMs) this.retire(entry);
    }
  }

  /** A pinned entry for this file, or null to read it from the store. */
  private async resolve(file: ParquetFile): Promise<Entry | null> {
    if (!this.enabled || file.bytes > this.ceiling) {
      Metrics.ParquetCacheRequests.inc({ result: CacheResult.Bypass });
      return null;
    }

    const id = cacheId(file);
    const existing = this.entries.get(id);
    if (existing && this.now() - existing.cachedAt < this.settings.maxAgeMs) {
      this.pin(existing);
      Metrics.ParquetCacheRequests.inc({ result: CacheResult.Hit });
      return existing;
    }
    if (existing) this.retire(existing);

    let pending = this.fetching.get(id);
    if (!pending) {
      pending = this.fetch(id, file).finally(() => this.fetching.delete(id));
      this.fetching.set(id, pending);
    }
    const entry = await pending;

    // Evicted between landing and here, which takes everything else being
    // pinned: read it from the store rather than hand out a deleted path.
    if (!entry || this.entries.get(id) !== entry) {
      Metrics.ParquetCacheRequests.inc({ result: CacheResult.Bypass });
      return null;
    }
    this.pin(entry);
    Metrics.ParquetCacheRequests.inc({ result: CacheResult.Miss });
    return entry;
  }

  private async fetch(id: string, file: ParquetFile): Promise<Entry | null> {
    // The manifest records each file's size; 0 is one whose `stat` failed at
    // roll-up, which is sized after the download instead.
    let held = 0;
    if (file.bytes > 0) {
      if (!this.reserve(file.bytes)) return null;
      held = file.bytes;
    }

    const path = join(
      this.settings.dir,
      `${PREFIX}${id}-${randomBytes(4).toString('hex')}.parquet`,
    );
    const partial = `${path}.partial`;
    try {
      await observe('ingot.parquet_cache_fetch', { 'ingot.bytes': file.bytes }, async () => {
        const source = await this.store.open(file.key);
        await pipeline(source, createWriteStream(partial, { flags: 'wx' }));
      });

      const { size } = await stat(partial);
      if (size !== held) {
        this.used -= held;
        held = 0;
        if (size > this.ceiling || !this.reserve(size)) {
          await rm(partial, { force: true });
          return null;
        }
        held = size;
      }

      // Renamed into place so a reader never sees half a file.
      await rename(partial, path);
      const now = this.now();
      const entry: Entry = {
        id,
        path,
        bytes: size,
        cachedAt: now,
        lastUsed: now,
        pins: 0,
        retired: false,
      };
      this.entries.set(id, entry);
      return entry;
    } catch (error) {
      this.used -= held;
      await rm(partial, { force: true }).catch(() => undefined);
      this.logger.warn(`Could not cache ${file.key}; reading it from the store: ${String(error)}`);
      return null;
    }
  }

  /** Makes room for `bytes` and counts it as used, or says there is none. */
  private reserve(bytes: number): boolean {
    while (this.used + bytes > this.settings.maxBytes) {
      const victim = this.leastRecentlyUsed();
      if (!victim) return false;
      this.remove(victim);
      Metrics.ParquetCacheEvictions.inc({ reason: EvictionReason.Lru });
    }
    this.used += bytes;
    return true;
  }

  private leastRecentlyUsed(): Entry | undefined {
    let oldest: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.pins > 0) continue;
      if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
    }
    return oldest;
  }

  /** Out of the index now; off the disk once nobody is reading it. */
  private retire(entry: Entry): void {
    this.entries.delete(entry.id);
    Metrics.ParquetCacheEvictions.inc({ reason: EvictionReason.Age });
    if (entry.pins === 0) {
      this.discard(entry);
    } else {
      entry.retired = true;
      this.retiring.add(entry);
    }
  }

  private remove(entry: Entry): void {
    this.entries.delete(entry.id);
    this.discard(entry);
  }

  private discard(entry: Entry): void {
    this.used -= entry.bytes;
    this.retiring.delete(entry);
    rm(entry.path, { force: true }).catch((error: unknown) => {
      this.logger.warn(`Could not remove cached ${entry.path}: ${String(error)}`);
    });
  }

  private pin(entry: Entry): void {
    entry.pins += 1;
    entry.lastUsed = this.now();
  }

  private unpin(entry: Entry): void {
    entry.pins -= 1;
    if (entry.retired && entry.pins === 0) this.discard(entry);
  }

  private get ceiling(): number {
    return this.settings.maxBytes / 4;
  }
}

function cacheId(file: ParquetFile): string {
  return createHash('sha256').update(`${file.table}\0${file.key}`).digest('hex').slice(0, 32);
}
