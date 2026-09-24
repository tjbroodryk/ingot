import { ConflictingState } from '../../domain/index.js';
import type { AggregateRoot, Identifier } from '../../domain/index.js';

/**
 * The optimistic-concurrency write, in one place: insert, or update only if the
 * on-disk version matches. A write matching nothing is a lost update, thrown as
 * `ConflictingState`. The version advances only after the write lands.
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
