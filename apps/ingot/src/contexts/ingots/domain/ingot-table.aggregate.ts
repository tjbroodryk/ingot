import type { ConfigureTableBody } from '@ingot/shared/ingot-v1';
import {
  AggregateRoot,
  ConflictingState,
  Guard,
  InvariantViolation,
} from '../../../shared/domain/index.js';
import { ColumnSpec } from './column-spec.vo.js';
import { IngotTableId } from './ingot-id.vo.js';
import { TableConfig } from './table-config.vo.js';
import { INGESTED_AT, RAW, ROW_ID, BATCH, SqlName } from './sql-name.vo.js';

/** One Parquet file in the base tier, as the manifest records it. */
export interface BaseFile {
  readonly key: string;
  readonly rows: number;
  readonly bytes: number;
}

interface TableProps {
  ingotId: string;
  name: SqlName;
  columns: ColumnSpec[];
  /** The columns that identify a row, in order. Empty when none was declared. */
  key: SqlName[];
  baseFiles: BaseFile[];
  vectorFiles: BaseFile[];
  generation: number;
  baseRows: number;
  createdAt: Date;
  config: TableConfig;
}

/**
 * Validates a declared key against the columns the mapping actually fills.
 *
 * A key naming a column that does not exist would produce receipts whose
 * queries refer to nothing — and it would do it silently, since the query is
 * only ever run by whoever received it.
 */
function keyColumns(
  declared: readonly string[],
  available: ReadonlySet<string>,
  table: string,
): SqlName[] {
  const seen = new Set<string>();

  return declared.map((raw) => {
    const column = SqlName.column(raw);
    if (!available.has(column.value)) {
      throw new InvariantViolation(
        `table "${table}" is keyed on "${column.value}", which this mapping does not fill. ` +
          `A key must name columns the write actually sets.`,
      );
    }
    if (seen.has(column.value)) {
      throw new InvariantViolation(`"${column.value}" appears twice in the key of "${table}"`);
    }
    seen.add(column.value);
    return column;
  });
}

/** The columns this service puts on every row, before any mapping runs. */
function systemColumns(withRaw: boolean): ColumnSpec[] {
  const columns = [
    ColumnSpec.of({ name: ROW_ID, type: 'VARCHAR', reserved: true }),
    ColumnSpec.of({ name: INGESTED_AT, type: 'TIMESTAMP', reserved: true }),
    ColumnSpec.of({ name: BATCH, type: 'VARCHAR', reserved: true }),
  ];
  if (withRaw) columns.push(ColumnSpec.of({ name: RAW, type: 'JSON', reserved: true }));
  return columns;
}

/**
 * A table's schema and where its data lives — the manifest, per table.
 *
 * This is the aggregate the write path contends on, which is why it is not
 * part of `Ingot`: two tools writing two tables of one memory should never
 * make each other retry. The version guard is per table for the same reason.
 *
 * `generation` counts roll-ups. It is not a version — a compaction bumps both,
 * but a schema change bumps only the version — and it is what makes an
 * in-flight query safe across a compaction: the old generation's files stay in
 * the bucket until a later sweep reaps them, so a query that resolved the
 * manifest a moment before the flip still reads something complete.
 */
export class IngotTable extends AggregateRoot<IngotTableId> {
  private props: TableProps;
  #changed = false;

  private constructor(id: IngotTableId, props: TableProps, version = 0) {
    super(id, version);
    this.props = props;
  }

  /**
   * Whether anything about this table has moved since it was loaded.
   *
   * Every `/add` used to save the manifest whether or not the schema changed,
   * which meant concurrent writes to one table contended on its version for no
   * reason at all — the steady state of this product is a stable schema and a
   * great many rows. A table with nothing to say is not written.
   */
  get hasChanges(): boolean {
    return this.#changed;
  }

  static declare(input: {
    ingotId: string;
    name: string;
    columns: readonly ColumnSpec[];
    key: readonly string[];
    raw: boolean;
    now: Date;
    /**
     * A table this service writes on a caller's behalf, so its name may carry
     * the reserved prefix. `/add` never sets it — `RowMapping` parses a
     * caller's table name with `SqlName.table`, which refuses the prefix, and
     * that asymmetry is what keeps `ingot_receipts` ours.
     */
    system?: boolean;
  }): IngotTable {
    const name = input.system ? SqlName.systemTable(input.name) : SqlName.table(input.name);
    Guard.notEmpty(input.columns, `table "${name.value}" columns`);

    const declared = new Set<string>();
    for (const column of input.columns) {
      if (declared.has(column.name.value)) {
        throw new InvariantViolation(`column "${column.name.value}" is declared twice`);
      }
      declared.add(column.name.value);
    }

    const declared_ = new IngotTable(IngotTableId.forTable(input.ingotId, name.value), {
      ingotId: input.ingotId,
      name,
      columns: [...systemColumns(input.raw), ...input.columns],
      key: keyColumns(input.key, declared, name.value),
      baseFiles: [],
      vectorFiles: [],
      generation: 0,
      baseRows: 0,
      createdAt: input.now,
      config: TableConfig.default(),
    });
    declared_.#changed = true;
    return declared_;
  }

  static rehydrate(id: IngotTableId, props: TableProps, version: number): IngotTable {
    return new IngotTable(id, props, version);
  }

  get ingotId(): string {
    return this.props.ingotId;
  }
  get name(): SqlName {
    return this.props.name;
  }
  get columns(): readonly ColumnSpec[] {
    return this.props.columns;
  }
  /** The columns that identify a row. Empty when none was declared. */
  get key(): readonly SqlName[] {
    return this.props.key;
  }
  get baseFiles(): readonly BaseFile[] {
    return this.props.baseFiles;
  }
  get vectorFiles(): readonly BaseFile[] {
    return this.props.vectorFiles;
  }
  get generation(): number {
    return this.props.generation;
  }
  get baseRows(): number {
    return this.props.baseRows;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  /** Its settings. Never absent — an unconfigured table holds the defaults. */
  get config(): TableConfig {
    return this.props.config;
  }

  column(name: string): ColumnSpec | undefined {
    return this.props.columns.find((candidate) => candidate.name.value === name.toLowerCase());
  }

  get embeddedColumns(): readonly ColumnSpec[] {
    return this.props.columns.filter((column) => column.embedded);
  }

  /**
   * Widens the schema to accept a write, or refuses it.
   *
   * A column the table has never seen is added, and added *optional*, because
   * every Parquet file already written lacks it. A column whose declared type
   * differs from the one on record is refused outright: silently widening
   * `INTEGER` to `VARCHAR` would change what a saved query returns without
   * anyone asking, and there is no honest coercion in the other direction.
   *
   * Returns the names it added, so `/add` can tell the caller what their
   * mapping changed about the table.
   */
  /**
   * Refuses a write that would change what identifies a row.
   *
   * Fixed for the same reason a column's type is: every receipt handed out so
   * far was written against this key, and quietly moving it would leave those
   * queries pointing at nothing in particular. Naming no key on a later write
   * is not a contradiction and is accepted.
   */
  assertKeyUnchanged(incoming: readonly string[]): void {
    if (incoming.length === 0) return;

    const declared = this.props.key.map((column) => column.value);
    const wanted = incoming.map((column) => column.toLowerCase());
    if (declared.length === wanted.length && declared.every((c, at) => c === wanted[at])) return;

    throw new ConflictingState(
      `table "${this.props.name.value}" is keyed on ` +
        `${declared.length > 0 ? `[${declared.join(', ')}]` : 'nothing'}; this write declares ` +
        `[${wanted.join(', ')}]. A table's key cannot change once rows exist under it — ` +
        'drop the table if it is wrong.',
    );
  }

  accommodate(incoming: readonly ColumnSpec[]): readonly string[] {
    const added: string[] = [];
    for (const column of incoming) {
      const existing = this.column(column.name.value);
      if (!existing) {
        this.props.columns = [...this.props.columns, column.asOptional()];
        added.push(column.name.value);
        this.#changed = true;
        continue;
      }
      if (existing.type !== column.type) {
        throw new ConflictingState(
          `column "${column.name.value}" of table "${this.props.name.value}" is ` +
            `${existing.type}; this write declares it ${column.type}. ` +
            'A column’s type cannot change once rows exist under it.',
        );
      }
      /*
       * Turning embedding on for a column that has it off is a widening the
       * table accepts — but only forwards, and that is a real limitation
       * rather than a detail.
       *
       * **The rows already stored are not embedded, and nothing will embed
       * them.** `OverlayStore.append` queues the rows of the write it is given
       * and there is no other way into `overlay_embed_queue`, so flipping this
       * covers every row written from here on and none of the ones already
       * here. Rows already rolled up into Parquet are not even in the overlay
       * to be found.
       *
       * It is worth being blunt because the failure is silent all the way
       * down: no error, and `ingot_embeddings_pending` counts the queue rather
       * than un-embedded rows, so the gauge reads zero while a semantic search
       * over this table quietly returns only what arrived after the flip.
       *
       * Refusing the widening was the alternative, and would be consistent
       * with how a type change is treated a few lines up. It is not refused
       * because a table that can never gain a searchable column is worse than
       * one that gains it from now on — and because the fix is a backfill,
       * which is planned: a sweeper that finds rows under an embeddable column
       * with no vector, across both tiers, and queues them. Until that exists,
       * a table that needs its history searchable is one to drop and store
       * again.
       */
      if (column.embedded && !existing.embedded) {
        this.props.columns = this.props.columns.map((candidate) =>
          candidate.name.value === column.name.value ? column.asOptional() : candidate,
        );
        this.#changed = true;
      }
    }
    return added;
  }

  /**
   * Applies a settings patch, and says whether it moved anything.
   *
   * Unlike a column or a key, configuration is *meant* to change: it describes
   * how the rows already here are read, not what they are, so nothing already
   * written stops being true when it moves. What does change is what a search
   * returns, and the index is rebuilt from the new settings on the next query
   * rather than left agreeing with the old ones.
   *
   * A patch that changes nothing does not mark the table dirty, for the reason
   * `hasChanges` exists at all: a no-op write would still contend on the
   * version with whatever is adding rows to this table right now.
   */
  configure(patch: ConfigureTableBody): boolean {
    const next = this.props.config.patched(patch);
    if (next.equals(this.props.config)) return false;

    this.props = { ...this.props, config: next };
    this.#changed = true;
    return true;
  }

  /**
   * Records a completed roll-up: a new generation replaces the old base.
   *
   * Both file lists are replaced wholesale rather than appended to, because
   * compaction rewrites everything it read. The caller is responsible for the
   * old generation's objects still being in the bucket when this returns.
   */
  rolledUp(input: { base: readonly BaseFile[]; vectors: readonly BaseFile[]; rows: number }): void {
    this.props = {
      ...this.props,
      baseFiles: [...input.base],
      vectorFiles: [...input.vectors],
      baseRows: input.rows,
      generation: this.props.generation + 1,
    };
    this.#changed = true;
  }
}
