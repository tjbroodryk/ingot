import { createHash } from 'node:crypto';
import { Identifier, newIdValue } from '../../../shared/domain/index.js';

export class IngotId extends Identifier {
  readonly prefix = 'ing';

  static of(value: string): IngotId {
    const id = new IngotId(value);
    id.validate();
    return id;
  }

  static generate(): IngotId {
    return IngotId.of(newIdValue('ing'));
  }
}

/**
 * A table's own identity, separate from `(ingot, name)`.
 *
 * The natural key would be the pair, but a table is an aggregate with a
 * version and a generation of its own — two tools writing to two tables of one
 * ingot must not contend — and the optimistic-concurrency machinery wants a
 * single-column identity to guard on. The pair is a unique index instead.
 */
export class IngotTableId extends Identifier {
  readonly prefix = 'tbl';

  static of(value: string): IngotTableId {
    const id = new IngotTableId(value);
    id.validate();
    return id;
  }

  static generate(): IngotTableId {
    return IngotTableId.of(newIdValue('tbl'));
  }

  /**
   * The id a table *must* have, derived from what already makes it unique.
   *
   * Two concurrent writes to a table that does not exist yet both create it.
   * With random ids they collide on the `(ingot_id, name)` index instead of on
   * the primary key — a raw unique violation, which aborts the transaction and
   * cannot be recovered in place, so one caller gets a 500 for doing nothing
   * wrong. Deriving the id turns that collision into an ordinary
   * optimistic-concurrency miss: no exception, a live transaction, and a loser
   * who can simply re-read what the winner created.
   *
   * Truncated to 24 hex characters, matching `newIdValue`. That is 96 bits
   * over a space that is one entry per table per ingot, so a collision is not
   * a thing to plan around.
   */
  static forTable(ingotId: string, name: string): IngotTableId {
    const digest = createHash('sha256').update(`${ingotId}:${name}`, 'utf8').digest('hex');
    return IngotTableId.of(`tbl_${digest.slice(0, 24)}`);
  }
}
