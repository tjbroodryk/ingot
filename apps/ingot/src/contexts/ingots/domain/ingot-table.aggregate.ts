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

/** Validates that a declared key names only columns the mapping actually fills. */
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
 * A table's schema and where its data lives — the manifest, per table. Separate
 * from `Ingot` so writes to different tables don't contend on one version.
 * `generation` counts roll-ups; old files linger so in-flight queries stay valid.
 */
export class IngotTable extends AggregateRoot<IngotTableId> {
  private props: TableProps;
  #changed = false;

  private constructor(id: IngotTableId, props: TableProps, version = 0) {
    super(id, version);
    this.props = props;
  }

  /** Whether anything about this table has moved since it was loaded. */
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
    /** A table this service writes on a caller's behalf; its name may carry the reserved prefix. */
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

  /** Refuses a write that changes what identifies a row. A write naming no key is accepted. */
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

  /**
   * Widens the schema to accept a write: unseen columns are added optional, a
   * changed type is refused. Returns the names it added.
   */
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
      // Turning embedding on only affects rows written from here on; existing
      // rows are never backfilled, so a table needing its history searchable
      // must be dropped and re-stored.
      if (column.embedded && !existing.embedded) {
        this.props.columns = this.props.columns.map((candidate) =>
          candidate.name.value === column.name.value ? column.asOptional() : candidate,
        );
        this.#changed = true;
      }
    }
    return added;
  }

  /** Applies a settings patch; returns whether it moved anything. A no-op leaves the table clean. */
  configure(patch: ConfigureTableBody): boolean {
    const next = this.props.config.patched(patch);
    if (next.equals(this.props.config)) return false;

    this.props = { ...this.props, config: next };
    this.#changed = true;
    return true;
  }

  /** Records a completed roll-up: a new generation replaces the base. Both file lists are replaced wholesale. */
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
