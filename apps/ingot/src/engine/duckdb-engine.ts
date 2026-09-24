import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBResultReader,
  DuckDBTypeId,
  StatementType,
} from '@duckdb/node-api';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { InvariantViolation } from '../shared/domain/index.js';
import { Metrics, RefusalReason, observe } from '../observability/index.js';
import { OBJECT_STORE, type ObjectStore } from '../storage/object-store.port.js';
import type {
  AnalyticalEngine,
  CompactionOutcome,
  CompactionRequest,
  MaterialisableTable,
  QueryOutcome,
  QueryRequest,
} from './analytical-engine.port.js';
import { floatArray, ident, literal, uriList } from './sql.js';
import { assertSelfContainedPredicate, assertStartsAsSelect } from './statement-shape.js';

export interface EngineLimits {
  readonly memoryLimit: string;
  readonly threads: number;
  /** Refuse to materialise an ingot bigger than this, with a clear message. */
  readonly maxMaterialisedRows: number;
  readonly extensionDirectory?: string;
  /**
   * Where DuckDB spills when a session exceeds `memoryLimit`; left unset it uses
   * the working directory, which may not be writable.
   */
  readonly temporaryDirectory?: string;
}

/** Raised instead of a bare error so the filter maps it and the metric counts it. */
class Refused extends InvariantViolation {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class DuckDbEngine implements AnalyticalEngine {
  private readonly logger = new Logger(DuckDbEngine.name);

  constructor(
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly limits: EngineLimits,
  ) {}

  async run(request: QueryRequest): Promise<QueryOutcome> {
    const started = performance.now();
    return this.withSession(
      request.tables,
      async (connection) => {
        await this.lockDown(connection);
        await this.assertPlainSelect(connection, request.sql);

        const sql = request.queryVector
          ? bindQueryVector(request.sql, request.queryVector)
          : request.sql;

        // One extra row, so "there were more" is a fact rather than a guess.
        const reader = await this.withTimeout(connection, request.timeoutMs, () =>
          connection.streamAndReadUntil(sql, request.rowCap + 1),
        );

        const withheld = embeddingColumns(reader);
        const columns = reader.columnNames().filter((_, index) => !withheld.indices.has(index));
        if (columns.length === 0 && reader.columnCount > 0) {
          throw new Refused(
            RefusalReason.EmbeddingOnly,
            'Embeddings are never returned — they are how this service ranks, not something ' +
              'to read. Select the columns you want, and use ' +
              'array_cosine_similarity(<column>_vec, $q) to order by meaning.',
          );
        }

        const all = reader.getRowObjectsJson();
        const truncated = all.length > request.rowCap;
        const capped = truncated ? all.slice(0, request.rowCap) : all;
        const rows = withheld.names.size === 0 ? capped : capped.map(withhold(withheld.names));

        Metrics.RowsReturned.observe({}, rows.length);
        return {
          columns,
          rows,
          truncated,
          elapsedMs: Math.round(performance.now() - started),
        };
      },
      request.sql,
    );
  }

  async resolveRows(request: {
    table: MaterialisableTable;
    where: string;
    cap: number;
    timeoutMs: number;
  }): Promise<{ rowIds: readonly string[]; truncated: boolean }> {
    // Wrap the predicate rather than run it: a caller supplies a WHERE clause,
    // not a statement. The balance check refuses predicates that break out of
    // their brackets (e.g. `1=1) UNION SELECT 1 --`), which stay a single SELECT
    // once wrapped and would otherwise pass every check.
    assertSelfContainedPredicate(request.where);

    const sql =
      `SELECT ${ident('_row_id')} FROM ${ident(request.table.name)} ` +
      `WHERE (${request.where}) LIMIT ${request.cap + 1}`;

    const outcome = await this.run({
      tables: [request.table],
      sql,
      rowCap: request.cap,
      timeoutMs: request.timeoutMs,
    });

    return {
      rowIds: outcome.rows.map((row) => String(row._row_id)),
      truncated: outcome.truncated,
    };
  }

  async compact(request: CompactionRequest): Promise<CompactionOutcome> {
    return this.withSession([request.table], async (connection) => {
      // Deliberately *not* locked down: this SQL is ours and it has to write.
      const table = ident(request.table.name);

      // Exclude vector columns; they go to the sibling file. `EXCLUDE ()` is
      // invalid SQL, so an unembedded table takes the plain projection.
      const excluded = vectorColumns(request.table);
      const projection =
        excluded.length > 0 ? `* EXCLUDE (${excluded.map(ident).join(', ')})` : '*';

      const rows = await this.write(request.baseTarget, (into) =>
        connection.run(
          `COPY (SELECT ${projection} FROM ${table})` +
            ` TO ${literal(into)} (FORMAT PARQUET, COMPRESSION zstd)`,
        ),
      ).then(() => this.count(connection, `SELECT count(*) AS n FROM ${table}`));

      let vectors = 0;
      const embedded = request.table.embedded;
      if (embedded.length > 0) {
        // Vectors go to their own file keyed by `_row_id`, so re-embedding
        // rewrites one small object rather than every base file.
        const projection = embedded
          .map((entry) => `${ident(vectorColumnName(entry.column))} AS ${ident(entry.column)}`)
          .join(', ');
        const anyPresent = embedded
          .map((entry) => `${ident(vectorColumnName(entry.column))} IS NOT NULL`)
          .join(' OR ');

        await this.write(request.vectorTarget, (into) =>
          connection.run(
            `COPY (SELECT ${ident('_row_id')}, ${projection} FROM ${table} WHERE ${anyPresent})` +
              ` TO ${literal(into)} (FORMAT PARQUET, COMPRESSION zstd)`,
          ),
        );
        vectors = await this.count(
          connection,
          `SELECT count(*) AS n FROM ${table} WHERE ${anyPresent}`,
        );
      }

      return { rows, vectors };
    });
  }

  /**
   * Writes one object with DuckDB, then publishes it. Split because some stores
   * stage to a scratch file uploaded on `commit` (DuckDB `COPY … TO` only takes
   * a local path or `s3://`). A failed write is discarded so nothing is left behind.
   */
  private async write(key: string, copy: (into: string) => Promise<unknown>): Promise<void> {
    const pending = await this.store.beginWrite(key);
    try {
      await copy(pending.target);
      await pending.commit();
    } catch (error) {
      await pending.discard().catch((failure: unknown) => {
        this.logger.warn(`Could not clean up an unfinished write of ${key}: ${String(failure)}`);
      });
      throw error;
    }
  }

  private async count(connection: DuckDBConnection, sql: string): Promise<number> {
    const [counted] = (await connection.runAndReadAll(sql)).getRowObjectsJson();
    return Number(counted?.n ?? 0);
  }

  // ── the session recipe ─────────────────────────────────────────────────

  /**
   * A fresh instance per call, never a fresh connection: connections to one
   * instance share a catalogue (table-name collisions), and
   * `enable_external_access`/`lock_configuration` are instance-wide.
   */
  private async withSession<T>(
    tables: readonly MaterialisableTable[],
    work: (connection: DuckDBConnection) => Promise<T>,
    narrowFor?: string,
  ): Promise<T> {
    const instance = await DuckDBInstance.create(':memory:');
    try {
      const connection = await instance.connect();
      await this.configure(connection);

      const needed = narrowFor ? narrow(connection, tables, narrowFor) : tables;
      await observe(
        'ingot.materialise',
        { 'ingot.tables': needed.length, 'ingot.tables_available': tables.length },
        async () => {
          for (const table of needed) await this.materialise(connection, table, narrowFor);
        },
      );
      return await work(connection);
    } finally {
      instance.closeSync();
    }
  }

  /** Steps 1–3: limits, extensions, then the store's own credentials. */
  private async configure(connection: DuckDBConnection): Promise<void> {
    await connection.run(`SET memory_limit = ${literal(this.limits.memoryLimit)}`);
    await connection.run(`SET threads = ${this.limits.threads}`);

    // No extension fetch at query time; a query reaching extensions.duckdb.org
    // would fail on a network that blocks it.
    await connection.run('SET autoinstall_known_extensions = false');
    await connection.run('SET autoload_known_extensions = false');
    await connection.run('SET allow_unsigned_extensions = false');
    if (this.limits.extensionDirectory) {
      await connection.run(`SET extension_directory = ${literal(this.limits.extensionDirectory)}`);
    }
    if (this.limits.temporaryDirectory) {
      await connection.run(`SET temp_directory = ${literal(this.limits.temporaryDirectory)}`);
    }

    // Load `fts` in every session while external access is still on. `LOAD` is
    // refused after lockdown, so a session that skipped it makes `match_bm25` a
    // catalog error. `INSTALL` reads from the baked `extension_directory`, so it
    // costs nothing.
    await connection.run('INSTALL fts');
    await connection.run('LOAD fts');

    for (const statement of await this.store.session()) {
      await connection.run(statement);
    }
  }

  /**
   * Step 4: build one logical table from both tiers. Schema comes from the
   * manifest; `INSERT … BY NAME` lets base files with differing columns coexist,
   * a missing column reading as null.
   */
  private async materialise(
    connection: DuckDBConnection,
    table: MaterialisableTable,
    sql?: string,
  ): Promise<void> {
    const name = ident(table.name);
    const definitions = table.columns.map(
      (column) => `${ident(column.name)} ${duckType(column.type)}`,
    );
    for (const entry of table.embedded) {
      definitions.push(`${ident(vectorColumnName(entry.column))} FLOAT[${entry.dimensions}]`);
    }
    await connection.run(`CREATE TABLE ${name} (${definitions.join(', ')})`);

    if (table.baseFiles.length > 0) {
      await connection.run(
        `INSERT INTO ${name} BY NAME ` +
          `SELECT * FROM read_parquet(${uriList(table.baseFiles)}, union_by_name := true)`,
      );
    }

    if (table.overlayRows.length > 0) {
      await this.appendOverlay(connection, table);
    }

    if (table.vectorFiles.length > 0 || table.overlayVectors.length > 0) {
      await this.attachVectors(connection, table);
    }

    if (table.tombstones.length > 0) {
      // Remove forgotten rows once here, not on every query reference.
      const ids = table.tombstones.map(literal).join(', ');
      await connection.run(`DELETE FROM ${name} WHERE ${ident('_row_id')} IN (${ids})`);
    }

    const [counted] = (
      await connection.runAndReadAll(`SELECT count(*) AS n FROM ${name}`)
    ).getRowObjectsJson();
    if (Number(counted?.n ?? 0) > this.limits.maxMaterialisedRows) {
      throw new Refused(
        RefusalReason.IngotTooLarge,
        `Table "${table.name}" holds more than ${this.limits.maxMaterialisedRows} rows, ` +
          'which is more than one query session will hold in memory. ' +
          'Narrow the memory, or split it across ingots.',
      );
    }

    if (sql !== undefined && wantsFullText(table, sql)) {
      await this.index(connection, table);
    }
  }

  /**
   * Builds the full text index a query is about to search. Per-session, since
   * the index lives in DuckDB's own tables over a table assembled per query.
   * Nothing is refused: a table with no text columns just returns no matches.
   */
  private async index(connection: DuckDBConnection, table: MaterialisableTable): Promise<void> {
    const columns = indexableColumns(table);
    if (columns.length === 0) return;

    await observe(
      'ingot.fts_index',
      { 'ingot.table': table.name, 'ingot.fts_columns': columns.length },
      () =>
        connection.run(
          `PRAGMA create_fts_index(${literal(table.name)}, ${literal('_row_id')}, ` +
            `${columns.map(literal).join(', ')}, ` +
            // `stopwords` is read by DuckDB as a table name unless it's
            // "english", so these are validated enums, not free strings.
            `stemmer=${literal(table.fts.stemmer)}, ` +
            `stopwords=${literal(table.fts.stopwords)}, ` +
            `ignore=${literal(table.fts.ignore)}, ` +
            `strip_accents=${table.fts.stripAccents ? 1 : 0}, ` +
            `lower=${table.fts.lowercase ? 1 : 0}, ` +
            'overwrite=1)',
        ),
    );
  }

  /**
   * Overlay rows go in through the appender, staged as `VARCHAR` and cast on
   * insert. The appender is strongly typed, so staging as text keeps one path
   * for all types; values were already validated at `/add`.
   */
  private async appendOverlay(
    connection: DuckDBConnection,
    table: MaterialisableTable,
  ): Promise<void> {
    const staging = `_overlay_${table.name}`;
    const columns = table.columns;

    await connection.run(
      `CREATE TABLE ${ident(staging)} (${columns
        .map((column) => `${ident(column.name)} VARCHAR`)
        .join(', ')})`,
    );

    const appender = await connection.createAppender(staging);
    try {
      for (const row of table.overlayRows) {
        for (const column of columns) {
          const value = row[column.name];
          if (value === null || value === undefined) appender.appendNull();
          else appender.appendVarchar(String(value));
        }
        appender.endRow();
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }

    await connection.run(
      `INSERT INTO ${ident(table.name)} BY NAME SELECT ` +
        columns
          .map(
            (column) => `${ident(column.name)}::${duckType(column.type)} AS ${ident(column.name)}`,
          )
          .join(', ') +
        ` FROM ${ident(staging)}`,
    );
    await connection.run(`DROP TABLE ${ident(staging)}`);
  }

  /** Folds both tiers of vectors onto the rows they belong to. */
  private async attachVectors(
    connection: DuckDBConnection,
    table: MaterialisableTable,
  ): Promise<void> {
    const staging = `_vectors_${table.name}`;
    await connection.run(
      `CREATE TABLE ${ident(staging)} (` +
        `${ident('_row_id')} VARCHAR, ${ident('column_name')} VARCHAR, ${ident('vec')} VARCHAR)`,
    );

    if (table.vectorFiles.length > 0) {
      // The sibling Parquet holds one column per embedded column, keyed by
      // row id; unpivot it into the same shape the overlay arrives in.
      for (const entry of table.embedded) {
        await connection.run(
          `INSERT INTO ${ident(staging)} ` +
            `SELECT ${ident('_row_id')}, ${literal(entry.column)}, ${ident(entry.column)}::VARCHAR ` +
            `FROM read_parquet(${uriList(table.vectorFiles)}, union_by_name := true) ` +
            `WHERE ${ident(entry.column)} IS NOT NULL`,
        );
      }
    }

    if (table.overlayVectors.length > 0) {
      const appender = await connection.createAppender(staging);
      try {
        for (const vector of table.overlayVectors) {
          appender.appendVarchar(vector.rowId);
          appender.appendVarchar(vector.column);
          // A list literal, cast back on the way out; text keeps one path, like the row staging.
          appender.appendVarchar(`[${vector.vector.join(',')}]`);
          appender.endRow();
        }
        appender.flushSync();
      } finally {
        appender.closeSync();
      }
    }

    for (const entry of table.embedded) {
      await connection.run(
        `UPDATE ${ident(table.name)} AS t ` +
          `SET ${ident(vectorColumnName(entry.column))} = v.${ident('vec')}::FLOAT[]::FLOAT[${entry.dimensions}] ` +
          `FROM ${ident(staging)} AS v ` +
          `WHERE t.${ident('_row_id')} = v.${ident('_row_id')} ` +
          `AND v.${ident('column_name')} = ${literal(entry.column)} ` +
          `AND len(v.${ident('vec')}::FLOAT[]) = ${entry.dimensions}`,
      );
    }
    await connection.run(`DROP TABLE ${ident(staging)}`);
  }

  /**
   * Step 5: revoke external access, then lock configuration; the order is the
   * security property. `lock_configuration` stops the query re-enabling access
   * and cannot be released.
   */
  private async lockDown(connection: DuckDBConnection): Promise<void> {
    await connection.run('SET enable_external_access = false');
    await connection.run('SET lock_configuration = true');
  }

  /**
   * Step 6: exactly one statement, and a SELECT. The lockdown does not refuse
   * `ATTACH ':memory:'`, so this check is load-bearing, not a formality.
   */
  private async assertPlainSelect(connection: DuckDBConnection, sql: string): Promise<void> {
    let count: number;
    try {
      count = (await connection.extractStatements(sql)).count;
    } catch (error) {
      throw new Refused(
        RefusalReason.DidNotParse,
        `That is not SQL DuckDB can parse: ${firstLine(error)}`,
      );
    }
    if (count === 0) {
      throw new Refused(RefusalReason.DidNotParse, 'No statement was given');
    }
    if (count > 1) {
      throw new Refused(
        RefusalReason.MultipleStatements,
        `Send one statement, not ${count}. A query is a single SELECT.`,
      );
    }

    // Check the written form before the type: DuckDB rewrites some `PRAGMA` into
    // a select, so `PRAGMA database_list` reaches `statementType` looking like
    // `SELECT 1`.
    assertStartsAsSelect(sql);

    let type: StatementType;
    const prepared = await connection.prepare(sql).catch((error: unknown) => {
      throw new Refused(RefusalReason.DidNotParse, `That query will not run: ${firstLine(error)}`);
    });
    try {
      type = prepared.statementType;
    } finally {
      prepared.destroySync();
    }

    if (type !== StatementType.SELECT) {
      throw new Refused(
        RefusalReason.NotASelect,
        `Only SELECT is allowed here, and this is ${StatementType[type] ?? 'something else'}. ` +
          'An ingot is written through /add and /delete, never through the query endpoint.',
      );
    }
  }

  /**
   * Step 7: enforce a deadline ourselves. DuckDB has no statement timeout;
   * `interrupt()` on the connection cancels the running query.
   */
  private async withTimeout<T>(
    connection: DuckDBConnection,
    timeoutMs: number,
    work: () => Promise<T>,
  ): Promise<T> {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      try {
        connection.interrupt();
      } catch (error) {
        this.logger.warn(`Could not interrupt a query that ran long: ${String(error)}`);
      }
    }, timeoutMs);

    try {
      return await work();
    } catch (error) {
      if (expired) {
        throw new Refused(
          RefusalReason.TimedOut,
          `That query ran longer than ${timeoutMs}ms and was cancelled`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Which of an ingot's tables this query needs. `getTableNames` returns `[]` both
 * for a `JOIN … USING (…)` and for an unparseable query, indistinguishably, so
 * an empty answer means materialise everything rather than nothing.
 */
function narrow(
  connection: DuckDBConnection,
  tables: readonly MaterialisableTable[],
  sql: string,
): readonly MaterialisableTable[] {
  let named: readonly string[];
  try {
    named = connection.getTableNames(sql, false);
  } catch {
    return tables;
  }
  if (named.length === 0) return tables;

  const wanted = new Set(named.map((name) => name.toLowerCase()));
  const selected = tables.filter((table) => wanted.has(table.name));
  // An unknown name isn't rejected here; the query fails with its own catalog
  // error. If nothing matched, fall back rather than build an empty session.
  return selected.length > 0 ? selected : tables;
}

/** The schema `create_fts_index` puts its macros in (DuckDB's naming): `notes` becomes `fts_main_notes`. */
export function ftsSchemaName(table: string): string {
  return `fts_main_${table}`;
}

/**
 * Whether this query searches this table. `match_bm25` is a macro in the index's
 * schema, so a query using it must name that schema. A miss just skips a build,
 * so a text check is acceptable here.
 */
function wantsFullText(table: MaterialisableTable, sql: string): boolean {
  return table.fts.enabled && sql.toLowerCase().includes(ftsSchemaName(table.name));
}

/**
 * The columns an index covers: what was configured, else every text column.
 * Filtered against the current table so a dropped column doesn't fail the pragma;
 * with nothing configured, service columns like `_row_id` are excluded.
 */
function indexableColumns(table: MaterialisableTable): string[] {
  const text = table.columns.filter((column) => column.type === ColumnType.Varchar);
  const configured = new Set(table.fts.columns);

  // Spelled out rather than imported: the engine knows session shape, not the domain's vocabulary.
  const chosen =
    configured.size === 0
      ? text.filter((column) => !column.name.startsWith('_'))
      : text.filter((column) => configured.has(column.name));

  return chosen.map((column) => column.name).filter((name) => name !== '_row_id');
}

/** Where a column's embedding lands once materialised, beside its text. */
export function vectorColumnName(column: string): string {
  return `${column}_vec`;
}

function vectorColumns(table: MaterialisableTable): string[] {
  return table.embedded.map((entry) => vectorColumnName(entry.column));
}

/**
 * Which result columns are embeddings, and so never returned. Found by type not
 * name (`SELECT *` and `SELECT patch_vec AS patch` are the same leak); `ARRAY` is
 * the fixed-width kind `materialise` declares, which no `ColumnType` produces.
 */
function embeddingColumns(reader: DuckDBResultReader): {
  indices: ReadonlySet<number>;
  names: ReadonlySet<string>;
} {
  const indices = new Set<number>();
  const names = new Set<string>();
  // Row objects are keyed by the deduplicated names, which differ from the
  // reported ones exactly when a statement selects one column twice.
  const keys = reader.deduplicatedColumnNames();
  for (let index = 0; index < reader.columnCount; index++) {
    if (reader.columnTypeId(index) !== DuckDBTypeId.ARRAY) continue;
    indices.add(index);
    const key = keys[index];
    if (key !== undefined) names.add(key);
  }
  return { indices, names };
}

/** Drops the withheld keys from a row, leaving the rest in their order. */
function withhold(
  names: ReadonlySet<string>,
): (row: Record<string, unknown>) => Record<string, unknown> {
  return (row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !names.has(key)));
}

function duckType(type: ColumnType): string {
  // The wire enum's values are DuckDB's own type names, so there's no mapping table to drift.
  return type;
}

/**
 * Substitutes the query embedding for `$q`. A textual substitution, not a bound
 * parameter, so the vector lands where DuckDB expects a literal.
 */
function bindQueryVector(sql: string, vector: readonly number[]): string {
  return sql.replaceAll(/\$q\b/g, floatArray(vector));
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

export { Refused };
