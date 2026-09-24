import { BackgroundKind, CONCURRENCY } from './background.js';

/**
 * The environment variable each queue's bound is read from. A `Record` over the
 * enum, so a queue added without one fails to compile.
 */
export const CONCURRENCY_KEYS: Record<BackgroundKind, string> = {
  [BackgroundKind.Embeddings]: 'INGOT_EMBEDDINGS_CONCURRENCY',
  [BackgroundKind.Receipts]: 'INGOT_RECEIPTS_CONCURRENCY',
  [BackgroundKind.Deliveries]: 'INGOT_DELIVERIES_CONCURRENCY',
  [BackgroundKind.Files]: 'INGOT_FILES_CONCURRENCY',
};

/** The most any one queue may be given; a typo guard rather than a resource limit. */
export const MAX_CONCURRENCY = 64;

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/** A requested concurrency bound this service will not honour. */
export class BackgroundMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundMisconfigured';
  }
}

/**
 * Reads each queue's concurrency bound from the environment, falling back to
 * `CONCURRENCY`. Refuses out-of-range values rather than clamping.
 */
export function concurrencyFrom(read: Setting): Record<BackgroundKind, number> {
  const bounds = { ...CONCURRENCY };

  for (const kind of Object.values(BackgroundKind)) {
    const key = CONCURRENCY_KEYS[kind];
    const raw = read(key)?.trim();
    // An empty variable is treated as unset.
    if (raw === undefined || raw === '') continue;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BackgroundMisconfigured(
        `${key} is "${raw}"; a concurrency is a whole number of drains, and at least one. ` +
          'Set it to 1 to work this queue one drain at a time.',
      );
    }
    if (parsed > MAX_CONCURRENCY) {
      throw new BackgroundMisconfigured(
        `${key} is ${parsed}, which is past the ${MAX_CONCURRENCY} this service will honour. ` +
          'That is a typo guard rather than a limit worth having — but remember this is per ' +
          'replica, so what your provider sees is this times however many pods are running.',
      );
    }

    bounds[kind] = parsed;
  }

  return bounds;
}
