/** A replica read a cached file, or put one there. */
export interface CachedFileUse {
  readonly id: string;
  readonly objectKey: string;
  readonly bytes: number;
  /** When the file landed on the volume, which the age counts from. */
  readonly cachedAt: Date;
  readonly usedAt: Date;
}

/** A file the index has let go of, for the sweep to delete from the volume. */
export interface EvictedFile {
  readonly id: string;
  readonly bytes: number;
}

/** The shared Parquet cache's bookkeeping across replicas: sizes, ages and last reads. */
export interface ParquetCacheIndex {
  /** Adds files not yet known; for known ones, moves last use forward only. */
  touch(uses: readonly CachedFileUse[]): Promise<void>;

  totalBytes(): Promise<number>;

  /** Marks everything under `prefix` as past its age, for a deleted table or ingot. */
  expirePrefix(prefix: string): Promise<void>;

  /** Takes out every file cached before `cachedBefore` and idle since `idleBefore`. */
  evictExpired(cachedBefore: Date, idleBefore: Date): Promise<readonly EvictedFile[]>;

  /** Takes out idle files, least recently used first, until at most `bytes` remain. */
  evictDownTo(bytes: number, idleBefore: Date): Promise<readonly EvictedFile[]>;

  /** Which of these ids it has a row for. */
  known(ids: readonly string[]): Promise<ReadonlySet<string>>;
}

export const PARQUET_CACHE_INDEX = Symbol('ParquetCacheIndex');
