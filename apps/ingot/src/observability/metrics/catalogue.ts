import { Buckets } from './buckets.js';
import { defineCounter, defineGauge, defineHistogram } from './metric.js';

/**
 * Every metric this service exports, in one file, so the whole cardinality
 * budget reads in one place.
 *
 * Naming rules:
 * - Every name starts `ingot_` and ends in its unit — `_seconds`, `_bytes`,
 *   `_total` for a counter, nothing for a gauge of things.
 * - Every metric has help text that reads as a sentence.
 * - Labels are closed sets, never an account, ingot or table name; per-request
 *   detail goes on the span via `observe(op, detail, work)`.
 *
 * Ad hoc measurement needs no entry; a block wrapped in `observe()` lands in
 * `Operation` below.
 */
export const Metrics = {
  /**
   * General-purpose duration histogram; target of every `observe()` and every
   * `@Observed` method that does not name its own. `op` is a code constant.
   */
  Operation: defineHistogram({
    name: 'ingot_operation_duration_seconds',
    help: 'Duration of an instrumented operation, by its declared name.',
    labels: ['op', 'outcome'],
    buckets: Buckets.Internal,
  }),

  // ── HTTP ────────────────────────────────────────────────────────────────
  /** `route` is the Express route template, never the resolved path; bounds cardinality. */
  HttpRequestDuration: defineHistogram({
    name: 'ingot_http_request_duration_seconds',
    help: 'Time to serve an HTTP request, from the first middleware to the last byte.',
    labels: ['method', 'route', 'status'],
    buckets: Buckets.Request,
  }),
  HttpRequestsInFlight: defineGauge({
    name: 'ingot_http_requests_in_flight',
    help: 'Requests currently being served.',
    labels: ['method'],
  }),

  // ── CQRS ────────────────────────────────────────────────────────────────
  CommandDuration: defineHistogram({
    name: 'ingot_command_duration_seconds',
    help: 'Time for a command to execute, including its transaction.',
    labels: ['command', 'outcome'],
    buckets: Buckets.Internal,
  }),
  QueryDuration: defineHistogram({
    name: 'ingot_query_duration_seconds',
    help: 'Time for a query to execute.',
    labels: ['query', 'outcome'],
    buckets: Buckets.Internal,
  }),

  // ── the write path ──────────────────────────────────────────────────────
  RowsIngested: defineCounter({
    name: 'ingot_rows_ingested_total',
    help: 'Rows written into the overlay by /add, after mapping and coercion.',
    labels: ['outcome'],
  }),
  /** Read at scrape time rather than maintained by increments. Says whether roll-up keeps up. */
  OverlayRows: defineGauge({
    name: 'ingot_overlay_rows',
    help:
      'Rows sitting in the overlay, waiting to be rolled up into Parquet. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),

  // ── the read path ───────────────────────────────────────────────────────
  /** Split by phase: materialising (bounded by base-tier memory) vs executing the caller's SQL. */
  SessionDuration: defineHistogram({
    name: 'ingot_query_session_duration_seconds',
    help: 'Time spent in one phase of building and running a DuckDB query session.',
    labels: ['phase', 'outcome'],
    buckets: Buckets.Internal,
  }),
  RowsReturned: defineHistogram({
    name: 'ingot_query_rows_returned',
    help: 'Rows handed back by a query, before the row cap truncated it.',
    labels: [],
    buckets: [1, 10, 100, 1_000, 10_000, 100_000],
  }),
  /** SQL refused before execution. `reason` is a closed set, never the engine's message. */
  SqlRefused: defineCounter({
    name: 'ingot_sql_refused_total',
    help: 'Queries refused before execution, by why.',
    labels: ['reason'],
  }),

  // ── roll-up ─────────────────────────────────────────────────────────────
  CompactionDuration: defineHistogram({
    name: 'ingot_compaction_duration_seconds',
    help: 'Time to roll one table’s overlay up into a new Parquet generation.',
    labels: ['outcome'],
    buckets: Buckets.Upstream,
  }),
  RowsCompacted: defineCounter({
    name: 'ingot_rows_compacted_total',
    help: 'Rows moved out of the overlay and into the base tier.',
    labels: [],
  }),

  // ── embedding ───────────────────────────────────────────────────────────
  EmbeddingsPending: defineGauge({
    name: 'ingot_embeddings_pending',
    help:
      'Overlay rows with an embeddable column and no vector yet. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  EmbeddingDuration: defineHistogram({
    name: 'ingot_embedding_duration_seconds',
    help: 'Time to embed one batch of texts.',
    labels: ['model', 'outcome'],
    buckets: Buckets.Upstream,
  }),

  // ── receipts ─────────────────────────────────────────────────────────────
  ReceiptsPending: defineGauge({
    name: 'ingot_receipts_pending',
    help:
      'Writes that asked for a summary and have not been given one yet. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  /** Receipts that ran out of attempts. Should sit at zero. */
  ReceiptsAbandoned: defineGauge({
    name: 'ingot_receipts_abandoned',
    help:
      'Receipts a model refused often enough that they are no longer retried. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  ReceiptDuration: defineHistogram({
    name: 'ingot_receipt_duration_seconds',
    help: 'Time to write one receipt — the model call and the row it produces.',
    labels: ['model', 'outcome'],
    buckets: Buckets.Upstream,
  }),

  // ── files ────────────────────────────────────────────────────────────────
  /** Uploads `/file` accepted, and the ones it refused before storing. */
  FilesAccepted: defineCounter({
    name: 'ingot_files_accepted_total',
    help: 'Documents accepted by /file, and documents refused before being stored.',
    labels: ['outcome'],
  }),
  FilesPending: defineGauge({
    name: 'ingot_files_pending',
    help:
      'Documents accepted and not yet parsed into chunks. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  /** Documents that ran out of attempts. Should sit at zero. */
  FilesAbandoned: defineGauge({
    name: 'ingot_files_abandoned',
    help:
      'Documents that failed to parse often enough that they are no longer retried. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  /** `media_type` is a label because the duration distribution is bimodal by format. */
  FileDuration: defineHistogram({
    name: 'ingot_file_duration_seconds',
    help: 'Time to turn one document into chunks — fetch, parse, chunk, extract and write.',
    labels: ['media_type', 'outcome'],
    buckets: Buckets.Upstream,
  }),
  ChunksWritten: defineCounter({
    name: 'ingot_chunks_written_total',
    help: 'Chunks written into ingot_file_chunks, by the format they came out of.',
    labels: ['media_type'],
  }),

  // ── delivery ─────────────────────────────────────────────────────────────
  DeliveriesPending: defineGauge({
    name: 'ingot_deliveries_pending',
    help:
      'Receipts announced to a memory’s delivery target and not yet sent. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  /** Deliveries that ran out of attempts; the receipt itself is fine. Should sit at zero. */
  DeliveriesAbandoned: defineGauge({
    name: 'ingot_deliveries_abandoned',
    help:
      'Receipts whose delivery failed often enough that it is no longer retried. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  /** `kind` is the transport (`webhook`, `rmq`), never an endpoint or queue name. */
  DeliveryDuration: defineHistogram({
    name: 'ingot_delivery_duration_seconds',
    help: 'Time to deliver one receipt to a memory’s target.',
    labels: ['kind', 'outcome'],
    buckets: Buckets.Upstream,
  }),

  // ── infrastructure ──────────────────────────────────────────────────────
  TransactionDuration: defineHistogram({
    name: 'ingot_transaction_duration_seconds',
    help: 'Time a database transaction was open.',
    labels: ['outcome'],
    buckets: Buckets.Internal,
  }),
  DbPoolConnections: defineGauge({
    name: 'ingot_db_pool_connections',
    help: 'Connections in the Postgres pool, by state.',
    labels: ['state'],
  }),
  /** `host` is a code constant (`s3`, `openai`), never a URL, bucket or tenant. */
  UpstreamDuration: defineHistogram({
    name: 'ingot_upstream_request_duration_seconds',
    help: 'Time for a call to an external service to return.',
    labels: ['host', 'operation', 'outcome'],
    buckets: Buckets.Upstream,
  }),
} as const;

/**
 * Gauges reporting a quantity shared across processes rather than each
 * process's own. All are read out of Postgres at scrape time, so every process
 * reports the same number; aggregate with `max()`, never `sum()`.
 */
export const DEPLOYMENT_WIDE: readonly string[] = [
  'ingot_overlay_rows',
  'ingot_embeddings_pending',
  'ingot_receipts_pending',
  'ingot_receipts_abandoned',
  'ingot_deliveries_pending',
  'ingot_deliveries_abandoned',
  // Both read out of `file_queue` at scrape time.
  'ingot_files_pending',
  'ingot_files_abandoned',
];

/** Gauges that are genuinely this process's own, where `sum()` is right. */
export const PER_PROCESS: readonly string[] = [
  'ingot_http_requests_in_flight',
  'ingot_db_pool_connections',
];

/** The pool states `DbPoolConnections` reports. */
export enum PoolState {
  Total = 'total',
  Idle = 'idle',
  Waiting = 'waiting',
}

/** Why a query was refused; the closed set of label values on `SqlRefused`. */
export enum RefusalReason {
  NotASelect = 'not_a_select',
  MultipleStatements = 'multiple_statements',
  DidNotParse = 'did_not_parse',
  TimedOut = 'timed_out',
  TooManyRows = 'too_many_rows',
  IngotTooLarge = 'ingot_too_large',
  EmbeddingOnly = 'embedding_only',
}
