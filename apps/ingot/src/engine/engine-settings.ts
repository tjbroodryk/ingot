import { section, text, textOr, whole } from '../config/vars.js';
import type { EngineLimits } from './duckdb-engine.js';

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
