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

/** A table's own identity, separate from `(ingot, name)`, so it can carry a version. */
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
   * The id a table must have, derived from `(ingot, name)`. Concurrent creates
   * then collide on the primary key — an ordinary version miss the loser can
   * re-read — rather than a raw unique violation. Truncated to 24 hex chars.
   */
  static forTable(ingotId: string, name: string): IngotTableId {
    const digest = createHash('sha256').update(`${ingotId}:${name}`, 'utf8').digest('hex');
    return IngotTableId.of(`tbl_${digest.slice(0, 24)}`);
  }
}
