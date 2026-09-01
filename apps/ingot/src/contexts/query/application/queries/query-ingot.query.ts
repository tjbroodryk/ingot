import { Inject } from '@nestjs/common';
import { QueryHandler } from '@nestjs/cqrs';
import type { QueryBody, QueryResult } from '@ingot/shared/ingot-v1';
import { InvariantViolation } from '../../../../shared/domain/index.js';
import { Query, type IQueryHandler } from '../../../../shared/application/index.js';
import { Metrics, Outcome, observe } from '../../../../observability/index.js';
import { EMBEDDER, type Embedder } from '../../../../ai/embedder.port.js';
import {
  ANALYTICAL_ENGINE,
  type AnalyticalEngine,
} from '../../../../engine/analytical-engine.port.js';
import { SessionBuilder } from '../../../../engine/session-builder.js';
import { vectorColumnName } from '../../../../engine/duckdb-engine.js';
import { ident } from '../../../../engine/sql.js';
import { IngotAccess } from '../../../ingots/application/ingot-access.js';
import {
  INGOT_TABLE_REPOSITORY,
  RAW,
  type IngotTable,
  type IngotTableRepository,
} from '../../../ingots/domain/index.js';

/** How long a caller's SQL may run, and how much of it comes back. */
export const QUERY_TIMEOUT_MS = 15_000;
export const DEFAULT_ROW_CAP = 1_000;
export const MAX_ROW_CAP = 10_000;

/** `POST /api/v1/:account/:ingot/query` */
export class QueryIngot extends Query<QueryResult> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly body: QueryBody,
  ) {
    super();
  }
}

/**
 * The read path, in all three of its modes.
 *
 * `sql` alone runs as written. `text` alone embeds the question and ranks one
 * table by similarity. Both together is the interesting one: the embedding is
 * bound as `$q` and the caller's own SQL can use it, so a hybrid search — a
 * WHERE clause on real columns, ordered by meaning — is one round trip rather
 * than a similarity search followed by a filter in the client.
 *
 * A query is emphatically not a command even though it arrives as a POST: it
 * changes nothing, so it gets no transaction. The POST is because SQL does not
 * belong in a URL.
 */
@QueryHandler(QueryIngot)
export class QueryIngotHandler implements IQueryHandler<QueryIngot> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(ANALYTICAL_ENGINE) private readonly engine: AnalyticalEngine,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    private readonly sessions: SessionBuilder,
  ) {}

  async execute(query: QueryIngot): Promise<QueryResult> {
    const { body } = query;
    const wantsSql = typeof body.sql === 'string' && body.sql.trim().length > 0;
    const wantsText = typeof body.text === 'string' && body.text.trim().length > 0;

    if (!wantsSql && !wantsText) {
      throw new InvariantViolation('Send "sql", or "text", or both — this query asks for nothing');
    }

    const ingot = await this.access.ingot(query.ingotId, query.accountId);
    const tables = await this.tables.listForIngot(ingot.id.value);
    if (tables.length === 0) {
      throw new InvariantViolation(
        'This ingot has no tables yet. Store something with /add before querying it.',
      );
    }

    const rowCap = Math.min(body.limit ?? DEFAULT_ROW_CAP, MAX_ROW_CAP);

    /*
     * A question is only comparable to the vectors it is ranked against.
     *
     * This memory recorded the model that wrote its embeddings, and if the
     * process is now configured for a different one, the honest answer is to
     * refuse. Ranking anyway would produce a number for every row — cosine
     * similarity between two unrelated vector spaces is perfectly well
     * defined and completely meaningless — so the failure would be an
     * ordinary-looking result set that is simply wrong, with nothing to
     * indicate it. The alternative to an error here is a silent one later.
     */
    if (wantsText) {
      ingot.assertEmbeddingMatches({
        model: this.embedder.model,
        dimensions: this.embedder.dimensions,
      });
    }

    const queryVector = wantsText
      ? await observe('ingot.embed_query', () =>
          this.embedder.embed([body.text as string]).then(([vector]) => vector),
        )
      : undefined;

    let sql: string;
    if (wantsSql) {
      sql = body.sql as string;
    } else {
      const target = pickTable(tables, body);
      sql = rankingSql(target, pickColumn(target, body), rowCap);
    }

    // Every table is offered; the engine narrows to the ones the statement
    // actually names. That decision belongs inside the session, where the
    // connection that can read the statement lives — see `narrow()` there.
    const available = await this.sessions.all(tables);

    const outcome = await observe('ingot.query', { 'ingot.mode': mode(wantsSql, wantsText) }, () =>
      this.engine.run({
        tables: available,
        sql,
        queryVector,
        rowCap,
        timeoutMs: QUERY_TIMEOUT_MS,
      }),
    );

    Metrics.SessionDuration.observe(
      { phase: 'execute', outcome: Outcome.Ok },
      outcome.elapsedMs / 1000,
    );
    return outcome;
  }
}

function mode(sql: boolean, text: boolean): string {
  if (sql && text) return 'hybrid';
  return sql ? 'sql' : 'semantic';
}

/**
 * Which table a plaintext question ranks.
 *
 * Named explicitly when there is more than one, because guessing would mean
 * silently searching the wrong memory — and the caller has `/info`, which
 * tells them exactly what there is to choose from.
 */
function pickTable(tables: readonly IngotTable[], body: QueryBody): IngotTable {
  if (body.table) {
    const named = tables.find((table) => table.name.value === body.table?.toLowerCase());
    if (!named) {
      throw new InvariantViolation(
        `This ingot has no table "${body.table}". It has: ${names(tables)}.`,
      );
    }
    return named;
  }

  const searchable = tables.filter((table) => table.embeddedColumns.length > 0);
  if (searchable.length === 1) return searchable[0] as IngotTable;
  if (searchable.length === 0) {
    throw new InvariantViolation(
      'No column in this ingot is embedded, so there is nothing to search by meaning. ' +
        'Mark a VARCHAR column with "embed": true in a mapping, or send "sql" instead.',
    );
  }
  throw new InvariantViolation(
    `Say which table to search — ${names(searchable)} all have embedded columns.`,
  );
}

function pickColumn(table: IngotTable, body: QueryBody): string {
  const embedded = table.embeddedColumns;
  if (body.column) {
    const named = embedded.find((column) => column.name.value === body.column?.toLowerCase());
    if (!named) {
      throw new InvariantViolation(
        `Column "${body.column}" of "${table.name.value}" is not embedded. ` +
          `Embedded columns are: ${embedded.map((column) => column.name.value).join(', ') || 'none'}.`,
      );
    }
    return named.name.value;
  }
  if (embedded.length === 0) {
    throw new InvariantViolation(
      `No column of "${table.name.value}" is embedded, so there is nothing to rank by`,
    );
  }
  if (embedded.length > 1) {
    throw new InvariantViolation(
      `Say which column to search — "${table.name.value}" embeds ` +
        `${embedded.map((column) => column.name.value).join(' and ')}.`,
    );
  }
  return (embedded[0] as (typeof embedded)[number]).name.value;
}

/**
 * The SQL a plaintext question becomes.
 *
 * Rows with no vector are excluded rather than ranked last: a null similarity
 * sorts unpredictably, and a row that has not been embedded yet is not a bad
 * match — it is an unknown one, and returning it as a weak result would be a
 * claim we cannot support.
 *
 * `EXCLUDE` rather than a bare `*`, so the search asks for the columns the
 * caller was promised and nothing else. The engine withholds embeddings from
 * every result anyway, but a statement that selects a column it will not be
 * given is one somebody has to explain later — and the projection here is the
 * one place a plaintext search can simply be written correctly. Every embedded
 * column goes, not only the one being ranked: the others are the same secret.
 *
 * `_raw` goes with them, for a different reason. It is not a secret — a caller
 * asked for it and may read it back — but it is the whole blob a row was
 * projected *from*, so a result carrying it hands back every returned column a
 * second time inside it. On a table whose columns are the interesting parts of
 * a tool result, that is three copies per row and a plaintext search costing
 * more to read than the work it was meant to save.
 *
 * Withheld from the projection rather than from the result, which is the
 * difference that matters: `SELECT _raw FROM t` still answers. This function
 * writes the SQL for a caller who did not write any, and volunteering the
 * largest column in the table is not what they asked for.
 */
function rankingSql(table: IngotTable, column: string, limit: number): string {
  const vector = ident(vectorColumnName(column));
  // Only when the table has one: DuckDB refuses an `EXCLUDE` naming a column
  // that is not there, and `_raw` exists only for a write that asked for it.
  const hasRaw = table.columns.some((spec) => spec.name.value === RAW);
  const withheld = [
    ...table.embeddedColumns.map((embedded) => ident(vectorColumnName(embedded.name.value))),
    ...(hasRaw ? [ident(RAW)] : []),
  ].join(', ');
  return (
    `SELECT * EXCLUDE (${withheld}), array_cosine_similarity(${vector}, $q) AS ${ident('score')} ` +
    `FROM ${ident(table.name.value)} WHERE ${vector} IS NOT NULL ` +
    `ORDER BY ${ident('score')} DESC LIMIT ${limit}`
  );
}

function names(tables: readonly IngotTable[]): string {
  return tables.map((table) => `"${table.name.value}"`).join(', ');
}
