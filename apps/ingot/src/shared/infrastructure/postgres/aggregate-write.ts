import { ConflictingState } from '../../domain/index.js';
import type { AggregateRoot, Identifier } from '../../domain/index.js';

/**
 * The optimistic-concurrency dance, in one place.
 *
 * `AggregateRoot.version` has always been the token; this is what finally
 * checks it. Every repository writes the same way — insert the row, or update
 * it only if the version on disk is still the one the caller loaded — and the
 * shape is identical enough across contexts that writing it out twelve times
 * would be twelve chances to forget the `setWhere`.
 *
 * A write that matches nothing is a lost update, not a no-op: someone else
 * saved between the load and the save, and the aggregate in hand made its
 * decisions against state that no longer exists. `ConflictingState` maps to
 * 409, which is the honest answer — the caller should reload and retry, and a
 * silent success would have thrown their change away.
 *
 * The version is advanced only after the write lands, so an aggregate whose
 * save threw is still describing the version it was actually loaded at.
 */
export async function writeAggregate<TId extends Identifier>(
  aggregate: AggregateRoot<TId>,
  write: (version: { next: number; expected: number }) => Promise<readonly unknown[]>,
): Promise<void> {
  const expected = aggregate.version;
  const next = expected + 1;

  const written = await write({ next, expected });
  if (written.length === 0) {
    throw new ConflictingState(
      `${aggregate.constructor.name} "${aggregate.id.value}" was changed by someone else — ` +
        `expected version ${expected}. Reload and try again.`,
    );
  }

  aggregate.markPersisted(next);
}
