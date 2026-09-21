import { section, whole } from '../../../config/vars.js';

export const GENERATION_GRACE_KEY = 'INGOT_GENERATION_GRACE_MS';

/**
 * How long a replaced Parquet generation stays readable.
 *
 * An hour by default: long enough for a caller to download a table and page
 * its pending writes against it at leisure, or for a DuckDB reading it by range
 * from behind a proxy to finish, and short enough that a busy table does not
 * pay for a day of superseded copies.
 */
export const DEFAULT_GENERATION_GRACE_MS = 3_600_000;

/** Well past the query timeout, which is the grace a query itself needs. */
const SHORTEST = 60_000;
const LONGEST = 7 * 86_400_000;

export const GENERATION_GRACE = Symbol('GenerationGrace');

export const generationGraceEnv = section(
  {
    [GENERATION_GRACE_KEY]: whole({
      fallback: DEFAULT_GENERATION_GRACE_MS,
      min: SHORTEST,
      max: LONGEST,
      rule:
        `; it is milliseconds, between ${SHORTEST} (a minute, past the query timeout) and ` +
        `${LONGEST} (a week). A replaced generation is kept this long for readers that ` +
        'resolved it before a roll-up replaced it.',
    }),
  },
  (vars) => vars[GENERATION_GRACE_KEY],
);
