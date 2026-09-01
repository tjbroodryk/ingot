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
   * Where DuckDB spills when a session exceeds `memoryLimit`.
   *
   * Its default is the working directory, which in a container is the image
   * layer — writable only because nothing said otherwise, and not writable at
   * all under a `readOnlyRootFilesystem` pod. Left unset the failure is a
   * query that dies on a permission error at whatever size starts spilling,
   * which is a size nobody hits until a tenant does.
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
    /*
     * The predicate is wrapped rather than run: a caller supplies a WHERE
     * clause, not a statement, and this is what makes that literally true.
     *
     * The wrapping only holds if the predicate cannot get out of its brackets.
     * `1=1) UNION SELECT 1 --` is still a single SELECT once wrapped, so every
     * check the engine makes would pass it — the balance check is what refuses
     * it, and it was added because that attack got through.
     */
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

      // The vector columns are excluded: they belong in the sibling file, so
      // that re-embedding rewrites one small object rather than every base
      // file. `EXCLUDE ()` is not valid SQL, so an unembedded table takes the
      // plain projection.
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
        // Vectors go to their own file keyed by `_row_id`, never as a column
        // in the data. Re-embedding with a better model then rewrites one
        // small object instead of every base file.
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
   * One object, written by DuckDB and then published.
   *
   * The two steps are separate because they are separate for at least one
   * store: DuckDB can `COPY … TO` a local path and an `s3://` URI and nothing
   * else, so a Google bucket is written by copying to a scratch file that the
   * store uploads on `commit`. A store writing straight at the object commits
   * by doing nothing.
   *
   * Whatever happens, a write that threw is discarded. Nothing would ever read
   * a half-written generation — a generation is read only once the manifest
   * names it, and the manifest is written after this returns — but nothing
   * would ever collect it either, and on the staging path that is a local disk
   * filling up one failed roll-up at a time.
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
   * A fresh instance per call, never a fresh connection.
   *
   * Phase 0 established both halves of why. Connections to one instance share
   * a catalogue, so two sessions would collide on table names. And
   * `enable_external_access` and `lock_configuration` are *instance*-wide, so
   * locking one caller's session down would lock every other session on that
   * instance — one tenant's query breaking the next one's.
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

    // Nothing fetches an extension at query time. A first query that reaches
    // out to extensions.duckdb.org is a first query that fails on a network
    // that does not allow it, and it fails for the wrong-looking reason.
    await connection.run('SET autoinstall_known_extensions = false');
    await connection.run('SET autoload_known_extensions = false');
    await connection.run('SET allow_unsigned_extensions = false');
    if (this.limits.extensionDirectory) {
      await connection.run(`SET extension_directory = ${literal(this.limits.extensionDirectory)}`);
    }
    if (this.limits.temporaryDirectory) {
      await connection.run(`SET temp_directory = ${literal(this.limits.temporaryDirectory)}`);
    }

    /*
     * Full text search, in every session rather than only the ones that use it.
     *
     * A caller cannot load it themselves. `LOAD` is refused after the lockdown
     * — and has to be, since the same statement reaches every other extension
     * too — so an ingot whose session did not load `fts` is one where
     * `match_bm25` is a catalog error no configuration can fix. Loading it here,
     * while external access is still on, is what makes the function there for
     * every table that asked to be indexed.
     *
     * `INSTALL` reads from `extension_directory`, which the image bakes at
     * build time (`scripts/bake-extensions.ts`); against a copy already there
     * it costs nothing and reaches nowhere.
     */
    await connection.run('INSTALL fts');
    await connection.run('LOAD fts');

    for (const statement of await this.store.session()) {
      await connection.run(statement);
    }
  }

  /**
   * Step 4: one logical table from two tiers.
   *
   * The schema comes from the manifest rather than from whatever the Parquet
   * happens to contain, so what a query sees is exactly what `/info` promised.
   * `INSERT … BY NAME` is what lets a base file written before a column
   * existed sit beside one written after: the missing column reads as null
   * instead of failing the read.
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
      // Forgotten rows are removed here, once, rather than being filtered on
      // every reference to the table in a caller's query.
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
   * Builds the full text index a caller's query is about to search.
   *
   * A per-session cost, because there is nowhere else to put it: the index is
   * DuckDB's own tables, and this session's copy of the table is assembled
   * from two tiers a moment before the query runs. Rebuilding it is also what
   * makes changing the settings free — nothing stored has to be rewritten, and
   * the next query indexes the new way.
   *
   * Only for a query that is going to use it. `wantsFullText` looks for the
   * schema the index creates, which every `match_bm25` call has to name, so a
   * roll-up and an ordinary SELECT pay nothing for a table with search on.
   *
   * Nothing is refused here. A table configured for search whose text columns
   * have all been dropped has nothing to index, and that is a table returning
   * no matches rather than a query returning an error about its own schema.
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
            // Every one of these is quoted, and the two that name a vocabulary
            // are enums parsed by `FtsSettings` before they get here.
            // `stopwords` in particular is read by DuckDB as a *table name*
            // when it is not "english", which is why it is not a free string.
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
   * Overlay rows arrive through the appender, staged as text and cast on the
   * way in.
   *
   * The appender is strongly typed — `appendVarchar` into a `TIMESTAMP` column
   * is an error, not a coercion — so appending directly into the real table
   * would mean a per-type branch that has to stay in step with `ColumnType`.
   * Staging every column as `VARCHAR` and letting DuckDB do the cast keeps one
   * path for all eight types, and the values are already validated: `coerce()`
   * ran at `/add` time, which is the point of doing it there.
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
          // A list literal DuckDB casts back on the way out, for the same
          // reason the row staging is text: one path instead of a typed one.
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
   * Step 5: revoke, then lock. The order is the security property.
   *
   * Everything the query needs is in memory by now, so nothing legitimate
   * wants the filesystem or the network again. `lock_configuration` is what
   * stops the caller's own SQL turning external access back on — and Phase 0
   * confirmed it refuses to be released, too.
   */
  private async lockDown(connection: DuckDBConnection): Promise<void> {
    await connection.run('SET enable_external_access = false');
    await connection.run('SET lock_configuration = true');
  }

  /**
   * Step 6: one statement, and that statement a SELECT.
   *
   * Not a formality. The lockdown refuses reads and writes outside the
   * session, but it does *not* refuse `ATTACH ':memory:'` — that touches no
   * filesystem and no network, and once attached a caller can allocate as much
   * as they like. This check is what stops it, which makes it the load-bearing
   * half of the sandbox rather than a second opinion.
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

    /*
     * Before the type: what the statement is written as.
     *
     * DuckDB rewrites some `PRAGMA` statements into a select over a table
     * function, so `PRAGMA database_list` reaches `statementType` looking
     * exactly like `SELECT 1`. The type describes what will run; it is not a
     * record of what was asked for, and this endpoint promises SELECT.
     */
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
   * Step 7: a deadline we enforce ourselves.
   *
   * DuckDB has no statement-timeout setting; `interrupt()` on the connection
   * is the mechanism, and Phase 0 confirmed it actually cancels rather than
   * merely being accepted.
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
 * Which of an ingot's tables this query actually needs.
 *
 * `getTableNames` reads a statement against an empty catalogue, which is the
 * case that matters — we have to ask before building anything. But Phase 0
 * established that it returns `[]` for any `JOIN … USING (…)` *and* for a
 * query it cannot parse, and the two are indistinguishable. So an empty answer
 * cannot mean "this query needs no tables"; it has to mean "materialise
 * everything", or a perfectly good query with a USING join would be told its
 * tables do not exist.
 *
 * Every failure mode therefore lands on materialising more than necessary,
 * which costs time. None of them lands on materialising too little, which
 * would cost correctness.
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
  // A name we do not recognise is not our business to reject here — the query
  // will fail on its own with a catalog error that names it, which is a better
  // message than anything this function could invent. But if nothing matched,
  // fall back rather than build an empty session.
  return selected.length > 0 ? selected : tables;
}

/**
 * The schema `create_fts_index` puts its macros in, for one table.
 *
 * DuckDB's own naming, reproduced because a caller has to type it: searching
 * `notes` is `fts_main_notes.match_bm25(_row_id, 'term')`.
 */
export function ftsSchemaName(table: string): string {
  return `fts_main_${table}`;
}

/**
 * Whether this query is going to search this table, rather than merely read it.
 *
 * A text check, and a narrowing one: `match_bm25` is a macro inside the
 * index's own schema, so a query that uses it *must* contain that schema's
 * name. Missing it costs the caller a search that finds nothing; a false
 * positive costs one wasted index build. Neither is a correctness problem,
 * which is what makes a text check acceptable here — unlike the ones in
 * `statement-shape.ts`, nothing is being kept out.
 */
function wantsFullText(table: MaterialisableTable, sql: string): boolean {
  return table.fts.enabled && sql.toLowerCase().includes(ftsSchemaName(table.name));
}

/**
 * The columns an index covers: what was configured, or every text column there
 * is.
 *
 * Filtered against the table as it actually stands, in both cases. A configured
 * column that a later write never brought back would otherwise fail the pragma,
 * and "your search settings name a column that no longer exists" is not a thing
 * to learn from a query about something else.
 *
 * Configuring nothing gets the caller's own VARCHAR columns and not this
 * service's. `_row_id` and `_batch` are ids that happen to be text: indexing
 * them fills the vocabulary with opaque tokens, and `_row_id` in particular is
 * the *document identifier* here, so it would rank every row against its own
 * key. A caller who genuinely wants one can still name it.
 */
function indexableColumns(table: MaterialisableTable): string[] {
  const text = table.columns.filter((column) => column.type === ColumnType.Varchar);
  const configured = new Set(table.fts.columns);

  // Spelled out rather than imported, as `_row_id` is everywhere else in this
  // file: the engine knows the shape of a session, not the domain's vocabulary.
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
 * Which columns of a result are embeddings, and therefore never leave here.
 *
 * A vector is how this service ranks — it is not a fact anybody stored and it
 * is not in what `/info` promises. Returning one is a few thousand floats of
 * noise per row, which for the caller this exists for, a model paying by the
 * token, is the difference between a readable answer and an unreadable one.
 *
 * Found by type rather than by name, because a name is only what a caller left
 * it as: `SELECT *` and `SELECT patch_vec AS patch` are the same leak and only
 * one of them is spellable in advance. `ARRAY` is the fixed-width kind, which
 * is what `materialise` declares a vector as and which no declarable
 * `ColumnType` can produce — `string_split` and an array literal are both
 * `LIST` and pass through untouched.
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
  // The wire enum's values are DuckDB's own type names, which is the point of
  // choosing them: there is no mapping table to fall out of step.
  return type;
}

/**
 * Substitutes the query embedding for `$q`.
 *
 * A textual substitution rather than a bound parameter because the vector is
 * ours — it came from the embedder, not from the caller — and because a caller
 * writing `array_cosine_similarity(patch_vec, $q)` should get the array in the
 * position DuckDB expects a literal, not a parameter it then has to cast.
 */
function bindQueryVector(sql: string, vector: readonly number[]): string {
  return sql.replaceAll(/\$q\b/g, floatArray(vector));
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

export { Refused };
