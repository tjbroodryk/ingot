import { z } from 'zod';
import { section, text, whole } from '../config/vars.js';

export interface DatabaseSettings {
  readonly url: string;
  /**
   * Sized for a pod, not for the cluster. Postgres' connection limit is a
   * cluster-wide budget, and this multiplies by replica count.
   */
  readonly poolMax: number;
}

export const databaseEnv = section(
  {
    DATABASE_URL: text(),
    DATABASE_POOL_MAX: whole({ fallback: 10, min: 1 }),
  },
  (vars, ctx): DatabaseSettings => {
    if (vars.DATABASE_URL === undefined) {
      ctx.addIssue('DATABASE_URL is not set — Ingot cannot start without its database.');
      return z.NEVER;
    }
    return { url: vars.DATABASE_URL, poolMax: vars.DATABASE_POOL_MAX };
  },
);
