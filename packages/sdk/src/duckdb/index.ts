import { type ColumnInfo, ColumnType } from '../contract.js';
import type { TableSnapshot } from '../memory.js';

export interface BaseFileRef {
  readonly table: string;
  readonly generation: number;
  readonly part: number;
}

export interface SessionSqlOptions {
  /** The name to create the table under. The table's own name unless given. */
  readonly as?: string;
  /**
   * Where DuckDB reads each base file from — typically your own proxy in front
   * of `…/parquet?generation=&part=`. Required when the snapshot has base files.
   */
  readonly url?: (file: BaseFileRef) => string;
  /** Overrides the snapshot's columns. */
  readonly columns?: readonly ColumnInfo[];
  /** `CREATE TEMP TABLE` rather than `CREATE TABLE`. */
  readonly temporary?: boolean;
  /** Rows per `INSERT` statement when staging the overlay. 500 unless given. */
  readonly batchSize?: number;
}

const DUCKDB_TYPES = new Set<string>(Object.values(ColumnType));

/**
 * The statements that rebuild one table inside your own DuckDB, in the order
 * to run them.
 *
 * Mirrors how the server assembles a table for `/query`, so the same SQL gets
 * the same answer either side: the manifest's declared types, the base Parquet
 * inserted by name (so a file written before a column existed reads it as
 * null), overlay rows staged as text and cast by DuckDB, then tombstoned rows
 * removed. There are no vector columns — embeddings never leave the server, so
 * similarity search stays a `/query`.
 *
 * Replaces any table of the same name, so a session can be refreshed by
 * running a newer snapshot's statements over it.
 */
export function sessionSql(snapshot: TableSnapshot, options: SessionSqlOptions = {}): string[] {
  const name = options.as ?? snapshot.table;
  const columns = options.columns ?? snapshot.columns;
  const batchSize = Math.max(1, options.batchSize ?? 500);
  const temp = options.temporary ? 'TEMP ' : '';

  if (columns.length === 0) {
    throw new TypeError(`Snapshot of "${snapshot.table}" has no columns to declare`);
  }
  for (const column of columns) {
    if (!DUCKDB_TYPES.has(column.type)) {
      throw new TypeError(`Column "${column.name}" has an undeclarable type "${column.type}"`);
    }
  }

  const statements: string[] = [
    `CREATE OR REPLACE ${temp}TABLE ${ident(name)} (${columns
      .map((column) => `${ident(column.name)} ${column.type}`)
      .join(', ')})`,
  ];

  if (snapshot.base.length > 0) {
    if (!options.url) {
      throw new TypeError('sessionSql needs { url } to read a snapshot that has base files');
    }
    const urls = snapshot.base.map((file) =>
      options.url?.({ table: snapshot.table, generation: snapshot.generation, part: file.part }),
    );
    statements.push(
      `INSERT INTO ${ident(name)} BY NAME ` +
        `SELECT * FROM read_parquet([${urls.map((url) => literal(url ?? '')).join(', ')}], union_by_name := true)`,
    );
  }

  if (snapshot.rows.length > 0) {
    const staging = `_overlay_${name}`;
    statements.push(
      `CREATE OR REPLACE TEMP TABLE ${ident(staging)} (${columns
        .map((column) => `${ident(column.name)} VARCHAR`)
        .join(', ')})`,
    );
    for (let start = 0; start < snapshot.rows.length; start += batchSize) {
      const values = snapshot.rows
        .slice(start, start + batchSize)
        .map((row) => `(${columns.map((column) => text(row.values[column.name])).join(', ')})`);
      statements.push(`INSERT INTO ${ident(staging)} VALUES ${values.join(', ')}`);
    }
    statements.push(
      `INSERT INTO ${ident(name)} BY NAME SELECT ${columns
        .map((column) => `${ident(column.name)}::${column.type} AS ${ident(column.name)}`)
        .join(', ')} FROM ${ident(staging)}`,
      `DROP TABLE ${ident(staging)}`,
    );
  }

  const tombstones = snapshot.tombstones.map((tombstone) => tombstone.rowId);
  for (let start = 0; start < tombstones.length; start += batchSize) {
    const ids = tombstones
      .slice(start, start + batchSize)
      .map(literal)
      .join(', ');
    statements.push(`DELETE FROM ${ident(name)} WHERE ${ident('_row_id')} IN (${ids})`);
  }

  return statements;
}

/** Quoted, with embedded quotes doubled — as the server's own `ident`. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The server appends `String(value)`, or null; so does this. */
function text(value: unknown): string {
  return value === null || value === undefined ? 'NULL' : literal(String(value));
}
