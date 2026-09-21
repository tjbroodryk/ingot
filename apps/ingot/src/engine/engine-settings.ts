import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { section, text, textOr, whole } from '../config/vars.js';
import type { EngineLimits } from './duckdb-engine.js';
import type { ParquetCacheSettings } from './parquet-cache.js';

/**
 * The limits a query session runs under.
 *
 * Configuration rather than constants because they are the knobs an operator
 * turns when a tenant's queries start costing more than the tenant does.
 */
export const engineEnv = section(
  {
    INGOT_QUERY_MEMORY_LIMIT: textOr('1GB'),
    INGOT_QUERY_THREADS: whole({ fallback: 2, min: 1 }),
    INGOT_MAX_TABLE_ROWS: whole({ fallback: 2_000_000, min: 1 }),
    INGOT_DUCKDB_EXTENSION_DIR: text(),
    INGOT_TEMP_DIR: text(),
    /**
     * Refused at boot rather than clamped: each one is a DuckDB instance with
     * its threads held idle, so a typo of 200 is memory and threads nobody chose.
     */
    INGOT_QUERY_WARM_SESSIONS: whole({
      fallback: 2,
      min: 0,
      max: 32,
      rule: '; it must be a whole number from 0 (open each session on demand) to 32.',
    }),
  },
  (vars): EngineLimits => ({
    memoryLimit: vars.INGOT_QUERY_MEMORY_LIMIT,
    threads: vars.INGOT_QUERY_THREADS,
    maxMaterialisedRows: vars.INGOT_MAX_TABLE_ROWS,
    extensionDirectory: vars.INGOT_DUCKDB_EXTENSION_DIR,
    temporaryDirectory: vars.INGOT_TEMP_DIR,
    warmSessions: vars.INGOT_QUERY_WARM_SESSIONS,
  }),
);

const SHORTEST_CACHE_AGE_MS = 60_000;
const LONGEST_CACHE_AGE_MS = 7 * 86_400_000;
const UNITS: Readonly<Record<string, number>> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 };

/** Bytes, or a whole number with a `Ki`, `Mi` or `Gi` suffix, as Kubernetes writes them. */
function bytes() {
  return text().transform((raw, ctx) => {
    if (raw === undefined) return 0;

    const quantity = /^(\d+)(Ki|Mi|Gi)$/.exec(raw);
    const parsed = quantity
      ? Number(quantity[1]) * (UNITS[quantity[2] as string] as number)
      : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      ctx.addIssue(
        '; it must be a whole number of bytes, or one like 2Gi, and 0 or unset turns the cache off.',
      );
      return z.NEVER;
    }
    return parsed;
  });
}

/** The shared Parquet cache, off unless a budget is given. */
export const parquetCacheEnv = section(
  {
    INGOT_PARQUET_CACHE_BYTES: bytes(),
    INGOT_PARQUET_CACHE_MAX_AGE_MS: whole({
      fallback: 86_400_000,
      min: SHORTEST_CACHE_AGE_MS,
      max: LONGEST_CACHE_AGE_MS,
      rule:
        `; it is milliseconds, between ${SHORTEST_CACHE_AGE_MS} (a minute) and ` +
        `${LONGEST_CACHE_AGE_MS} (a week).`,
    }),
    INGOT_PARQUET_CACHE_DIR: textOr(join(tmpdir(), 'ingot-parquet-cache')),
  },
  (vars): ParquetCacheSettings => ({
    dir: vars.INGOT_PARQUET_CACHE_DIR,
    maxBytes: vars.INGOT_PARQUET_CACHE_BYTES,
    maxAgeMs: vars.INGOT_PARQUET_CACHE_MAX_AGE_MS,
  }),
);
