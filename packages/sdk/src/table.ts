import {
  type ColumnMapping,
  ColumnType,
  type ExtractMapping,
  type FileExtraction,
} from './contract.js';

/**
 * Where a column's value comes from.
 *
 * `path` and `value` are what `/add` can fill. `model` is a column with neither,
 * which only a document extraction can fill — a model reads the prose and the
 * `describe` text says what to look for. The distinction is carried in the type
 * so `add` refuses a table that would be refused at runtime.
 */
export type ColumnSource = 'path' | 'value' | 'model';

/**
 * How each type comes back from `/query`.
 *
 * Checked against DuckDB's JSON rendering, which is what the server returns:
 * BIGINT is a string at every size so it never loses precision, TIMESTAMP is
 * `2026-09-17 10:11:12.345` (space, no zone), DATE is `2026-09-17`, and JSON is
 * the serialised text rather than a parsed value.
 */
export interface ColumnValues {
  [ColumnType.Varchar]: string;
  [ColumnType.Integer]: number;
  [ColumnType.BigInt]: string;
  [ColumnType.Double]: number;
  [ColumnType.Boolean]: boolean;
  [ColumnType.Timestamp]: string;
  [ColumnType.Date]: string;
  [ColumnType.Json]: string;
}

type Constant = string | number | boolean | null;

interface ColumnState {
  readonly type: ColumnType;
  readonly from?: string;
  readonly value?: Constant;
  readonly describe?: string;
  readonly embed?: boolean;
}

export class Column<
  TType extends ColumnType = ColumnType,
  TSource extends ColumnSource = ColumnSource,
> {
  /** Type-level only. */
  declare readonly __source: TSource;

  constructor(protected readonly state: ColumnState & { readonly type: TType }) {}

  get type(): TType {
    return this.state.type;
  }

  /**
   * What this column is, in words, for a model extracting it from a document.
   * Ignored by the server when the column also has a path.
   */
  describe(text: string): this {
    return this.with({ describe: text });
  }

  toJSON(): ExtractMapping {
    const { type, from, value, describe, embed } = this.state;
    return {
      type,
      ...(from === undefined ? {} : { from }),
      ...('value' in this.state ? { value: value ?? null } : {}),
      ...(describe === undefined ? {} : { describe }),
      ...(embed ? { embed: true } : {}),
    };
  }

  /** The `/add` half: `describe` means nothing there. */
  toMapping(): ColumnMapping {
    const { describe: _unused, ...mapping } = this.toJSON();
    return mapping;
  }

  protected with(patch: Partial<ColumnState>): this {
    const Self = this.constructor as new (state: ColumnState) => this;
    return new Self({ ...this.state, ...patch });
  }
}

export class VarcharColumn<
  TSource extends ColumnSource = ColumnSource,
  TEmbedded extends boolean = false,
> extends Column<ColumnType.Varchar, TSource> {
  /** Type-level only. */
  declare readonly __embedded: TEmbedded;

  /** Embed this column's text so it can be searched by meaning. */
  embed(): VarcharColumn<TSource, true> {
    return this.with({ embed: true }) as unknown as VarcharColumn<TSource, true>;
  }
}

export interface ColumnFactory<T extends ColumnType> {
  /** Read the value from a path into the result — `$.a.b`, or `$$.a` from the whole blob. */
  (path: string): Column<T, 'path'>;
  /** No path: for document extraction, filled by a model from `.describe()`. */
  (): Column<T, 'model'>;
  /** The same constant in every row. */
  value(value: Constant): Column<T, 'value'>;
}

export interface VarcharFactory {
  (path: string): VarcharColumn<'path'>;
  (): VarcharColumn<'model'>;
  value(value: Constant): VarcharColumn<'value'>;
}

function factory<T extends ColumnType>(type: T): ColumnFactory<T> {
  const make = (path?: string) =>
    new Column({ type, ...(path === undefined ? {} : { from: path }) });
  return Object.assign(make, {
    value: (value: Constant) => new Column({ type, value }),
  }) as ColumnFactory<T>;
}

function varcharFactory(): VarcharFactory {
  const type = ColumnType.Varchar;
  const make = (path?: string) =>
    new VarcharColumn({ type, ...(path === undefined ? {} : { from: path }) });
  return Object.assign(make, {
    value: (value: Constant) => new VarcharColumn({ type, value }),
  }) as VarcharFactory;
}

/** Column builders, one per type a mapping may declare. */
export const col = {
  varchar: varcharFactory(),
  integer: factory(ColumnType.Integer),
  bigint: factory(ColumnType.BigInt),
  double: factory(ColumnType.Double),
  boolean: factory(ColumnType.Boolean),
  timestamp: factory(ColumnType.Timestamp),
  date: factory(ColumnType.Date),
  json: factory(ColumnType.Json),
};

export type AnyColumn = Column<ColumnType, ColumnSource>;
export type Columns = Readonly<Record<string, AnyColumn>>;

interface TableState {
  readonly name: string;
  readonly rows?: string;
  readonly columns: Readonly<Record<string, AnyColumn>>;
  readonly key?: readonly string[];
  readonly raw?: boolean;
}

/** The part of an `/add` body a table definition supplies. */
export interface TableMapping {
  readonly table: string;
  readonly rows?: string;
  readonly columns: Readonly<Record<string, ColumnMapping>>;
  readonly key?: readonly string[];
  readonly raw?: boolean;
}

/**
 * A table's shape, declared once and reused for every write, extraction and
 * typed read against it. Immutable: every method returns a new definition.
 */
export class TableDef<
  TName extends string = string,
  TColumns extends Columns = Columns,
  TRaw extends boolean = false,
> {
  /** Type-level only. */
  declare readonly __raw: TRaw;

  constructor(private readonly state: TableState & { readonly name: TName }) {}

  get name(): TName {
    return this.state.name;
  }

  get columnDefs(): TColumns {
    return this.state.columns as TColumns;
  }

  /** A path to an array, fanned out into one row per element — `$.items[*]`. */
  rows(path: string): TableDef<TName, TColumns, TRaw> {
    return new TableDef({ ...this.state, rows: path });
  }

  /** Adds columns, keeping the ones already declared. */
  columns<TMore extends Columns>(
    columns: TMore,
  ): TableDef<TName, Omit<TColumns, keyof TMore> & TMore, TRaw> {
    return new TableDef({ ...this.state, columns: { ...this.state.columns, ...columns } });
  }

  /** The columns that identify a row, in order. Fixed once the table exists. */
  key(...columns: (keyof TColumns & string)[]): TableDef<TName, TColumns, TRaw> {
    return new TableDef({ ...this.state, key: columns });
  }

  /** Keep each whole result in `_raw` beside the mapped columns. */
  raw(): TableDef<TName, TColumns, true> {
    return new TableDef({ ...this.state, raw: true }) as TableDef<TName, TColumns, true>;
  }

  toJSON(): TableMapping {
    const { name, rows, columns, key, raw } = this.state;
    return {
      table: name,
      ...(rows === undefined ? {} : { rows }),
      columns: Object.fromEntries(
        Object.entries(columns).map(([column, def]) => [column, def.toMapping()]),
      ),
      ...(key === undefined ? {} : { key }),
      ...(raw ? { raw: true } : {}),
    };
  }

  /** The same definition as `extract` for a document upload. */
  toExtraction(): FileExtraction {
    const { name, rows, columns, key } = this.state;
    return {
      table: name,
      ...(rows === undefined ? {} : { rows }),
      columns: Object.fromEntries(
        Object.entries(columns).map(([column, def]) => [column, def.toJSON()]),
      ),
      ...(key === undefined ? {} : { key }),
    };
  }
}

export function table<TName extends string>(
  name: TName,
): TableDef<TName, Record<never, AnyColumn>> {
  return new TableDef({ name, columns: {} });
}

/** A definition every column of which `/add` can fill. */
export interface AddableTable {
  readonly name: string;
  readonly columnDefs: Readonly<Record<string, Column<ColumnType, 'path' | 'value'>>>;
  toJSON(): TableMapping;
}

type ValueOf<C> =
  C extends Column<infer T, ColumnSource>
    ? T extends keyof ColumnValues
      ? ColumnValues[T]
      : unknown
    : unknown;

/** The columns every row carries, whatever was mapped. */
export interface SystemColumns {
  readonly _row_id: string;
  readonly _ingested_at: string;
  readonly _batch: string;
}

/**
 * A row of a table as `/query` returns it for `SELECT *`.
 *
 * Every mapped column is nullable: a path missing from a result, and a column
 * added after earlier rows were written, both read as null.
 */
export type Infer<D> =
  D extends TableDef<string, infer TColumns, infer TRaw>
    ? { -readonly [K in keyof TColumns]: ValueOf<TColumns[K]> | null } & SystemColumns &
        (TRaw extends true ? { readonly _raw: string | null } : unknown)
    : never;

/** The names of a definition's embedded columns. */
export type EmbeddedColumns<D> =
  D extends TableDef<string, infer TColumns, boolean>
    ? {
        [K in keyof TColumns]: TColumns[K] extends VarcharColumn<ColumnSource, true> ? K : never;
      }[keyof TColumns] &
        string
    : string;
