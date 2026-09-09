import { BackgroundKind, CONCURRENCY } from './background.js';

/**
 * The variable each queue's bound is read from.
 *
 * A `Record` over the enum, so a queue added without one fails to compile —
 * and written out in full rather than derived from the enum value, because a
 * name built by string concatenation is a name nobody can grep for from a
 * deployment manifest.
 */
export const CONCURRENCY_KEYS: Record<BackgroundKind, string> = {
  [BackgroundKind.Embeddings]: 'INGOT_EMBEDDINGS_CONCURRENCY',
  [BackgroundKind.Receipts]: 'INGOT_RECEIPTS_CONCURRENCY',
  [BackgroundKind.Deliveries]: 'INGOT_DELIVERIES_CONCURRENCY',
  [BackgroundKind.Files]: 'INGOT_FILES_CONCURRENCY',
};

/**
 * The most any one queue may be given, and it is a typo guard rather than a
 * resource limit.
 *
 * The real bound is your provider's quota, and this service cannot know it —
 * nor is the database the constraint, since a drain holds a connection for the
 * few milliseconds of claim and save out of every call. What this catches is
 * `1000` typed for `100`, or a value that arrived with a unit suffix and parsed
 * as something else entirely.
 */
export const MAX_CONCURRENCY = 64;

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/** A deployment that asked for a bound this service will not honour. */
export class BackgroundMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundMisconfigured';
  }
}

/**
 * How many drains of each kind this deployment allows at once.
 *
 * **These are per replica, and that is the number to think in.** The wake path
 * takes no advisory lock — only a sweep does — so what a provider actually sees
 * is this times the replica count, and the chart's autoscaler moves that number
 * on CPU. Two per pod at ten pods is twenty concurrent calls at whatever
 * `INGOT_EMBEDDER` names, arriving precisely when load is highest. Set these
 * against a quota divided by `maxReplicas`, not against one pod.
 *
 * A pure function over a reader, like `ai-settings.ts` and
 * `delivery-settings.ts`, so the whole matrix is asserted in a unit test rather
 * than by booting the service once per shape.
 *
 * Refusing rather than clamping, for the reason the other two settings modules
 * refuse: a deployment that asked for something and silently got something else
 * has no way to find out, and the number here is one somebody chose against a
 * quota they were looking at.
 */
export function concurrencyFrom(read: Setting): Record<BackgroundKind, number> {
  const bounds = { ...CONCURRENCY };

  for (const kind of Object.values(BackgroundKind)) {
    const key = CONCURRENCY_KEYS[kind];
    const raw = read(key)?.trim();
    // An empty variable is an unset one — a deployment template left blank.
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
