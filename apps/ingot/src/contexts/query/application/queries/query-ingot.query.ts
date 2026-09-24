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
 * The read path in three modes: `sql` runs as written, `text` ranks one table by
 * similarity, both binds the embedding as `$q` for hybrid search. No transaction;
 * POST only because SQL does not belong in a URL.
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

    // Refuse if the process's embedder differs from the one that wrote this
    // memory's vectors — ranking across models is meaningless.
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

    // Offer every table; the engine narrows to the ones the statement names.
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

/** Which table a plaintext question ranks; must be named when more than one is searchable. */
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
 * The SQL a plaintext question becomes: ranks by cosine similarity, excludes
 * rows with no vector, and withholds every embedding column and `_raw` from the
 * projection (they can still be selected explicitly).
 */
function rankingSql(table: IngotTable, column: string, limit: number): string {
  const vector = ident(vectorColumnName(column));
  // Only if present: DuckDB refuses an `EXCLUDE` naming a column that is not there.
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
