import { section, text } from '../config/vars.js';
import { SweptKind } from './kinds.js';

export const SKIP_SWEEPERS_KEY = 'INGOT_SKIP_SWEEPERS';

export interface SweeperSettings {
  /** The sweeps this process runs. */
  readonly run: readonly SweptKind[];
}

/**
 * Sweeps this process leaves to another, by kind: `roll_up`, `embeddings`,
 * `receipts`, `deliveries`, `expiry`, `files`. Unset, it runs them all, which
 * is what a single process needs. `roll-up.ts` ignores this and runs roll-up
 * alone.
 */
export const sweepersEnv = section(
  { [SKIP_SWEEPERS_KEY]: text() },
  (vars, ctx): SweeperSettings => {
    const known = Object.values(SweptKind) as string[];
    const skipped = (vars[SKIP_SWEEPERS_KEY] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== '');

    const unknown = skipped.filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      ctx.addIssue(
        `${SKIP_SWEEPERS_KEY} names ${unknown.join(', ')}, which is not a sweep. ` +
          `The sweeps are ${known.join(', ')}.`,
      );
    }
    return { run: Object.values(SweptKind).filter((kind) => !skipped.includes(kind)) };
  },
);
