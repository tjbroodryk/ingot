import { section, whole } from '../../../config/vars.js';

export const ROLL_UP_MIN_ROWS_KEY = 'INGOT_ROLLUP_MIN_ROWS';
export const ROLL_UP_INTERVAL_KEY = 'INGOT_ROLLUP_INTERVAL_MS';
export const ROLL_UP_CONCURRENCY_KEY = 'INGOT_ROLLUP_CONCURRENCY';

/**
 * How deep an overlay has to get before it is rolled up early.
 *
 * Too low and a busy table rewrites its Parquet to fold in a handful of rows.
 * Too high and queries carry a large overlay until the interval catches it.
 */
export const DEFAULT_ROLL_UP_MIN_ROWS = 1_000;

/** The longest a row waits in the overlay, however few are with it. */
export const DEFAULT_ROLL_UP_INTERVAL_MS = 300_000;

/**
 * Compactions one replica runs at once. Each is a DuckDB session that may use
 * up to `INGOT_QUERY_MEMORY_LIMIT`, so size this against the pod's memory.
 */
export const DEFAULT_ROLL_UP_CONCURRENCY = 4;

const SHORTEST = 60_000;
const LONGEST = 86_400_000;
const MOST_CONCURRENT = 25;

export interface RollUpSettings {
  readonly minRows: number;
  readonly intervalMs: number;
  readonly concurrency: number;
}

export const ROLL_UP_SETTINGS = Symbol('RollUpSettings');

/** When a table is rolled up: this many overlay rows, or its oldest this old. */
export const rollUpEnv = section(
  {
    [ROLL_UP_MIN_ROWS_KEY]: whole({
      fallback: DEFAULT_ROLL_UP_MIN_ROWS,
      min: 1,
      rule:
        '; it is a number of overlay rows, at least 1. A table that reaches it is rolled up ' +
        'straight away rather than waiting out INGOT_ROLLUP_INTERVAL_MS.',
    }),
    [ROLL_UP_INTERVAL_KEY]: whole({
      fallback: DEFAULT_ROLL_UP_INTERVAL_MS,
      min: SHORTEST,
      max: LONGEST,
      rule:
        `; it is milliseconds, between ${SHORTEST} (a minute) and ${LONGEST} (a day). A table ` +
        'is rolled up this long after its first write, however few rows it has.',
    }),
    [ROLL_UP_CONCURRENCY_KEY]: whole({
      fallback: DEFAULT_ROLL_UP_CONCURRENCY,
      min: 1,
      max: MOST_CONCURRENT,
      rule:
        `; it is a number of compactions, between 1 and ${MOST_CONCURRENT}. Each may use up to ` +
        'INGOT_QUERY_MEMORY_LIMIT, so size it against the memory a pod has.',
    }),
  },
  (vars): RollUpSettings => ({
    minRows: vars[ROLL_UP_MIN_ROWS_KEY],
    intervalMs: vars[ROLL_UP_INTERVAL_KEY],
    concurrency: vars[ROLL_UP_CONCURRENCY_KEY],
  }),
);
