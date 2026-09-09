import { Buckets } from './buckets.js';
import { defineCounter, defineGauge, defineHistogram } from './metric.js';

/**
 * Every metric this service exports, in one file.
 *
 * One file rather than a declaration next to each use, because a metric's cost
 * is not paid where it is recorded — it is paid in the store and on the
 * dashboards, and neither can be reasoned about from a call site. Here the
 * whole cardinality budget reads in one screen, and `metric-catalogue.test.ts`
 * holds the naming rules mechanically instead of a reviewer remembering them.
 *
 * The rules, all enforced by that test:
 *
 * - Every name starts `ingot_` and ends in its unit — `_seconds`, `_bytes`,
 *   `_total` for a counter, nothing for a gauge of things.
 * - Every metric has help text that reads as a sentence.
 * - Labels are closed sets. Nothing here may be labelled by account, ingot or
 *   table name: this is a multi-tenant service and a tenant id on a label is a
 *   series per tenant, for the whole retention window. Per-tenant detail goes
 *   on the span, where `observe(op, detail, work)` puts it and where it costs
 *   nothing.
 *
 * Ad hoc measurement does not need an entry. A block wrapped in `observe()`
 * lands in `Operation` below, which is what makes instrumenting a code path a
 * one-line change rather than a change here and a change there.
 */
export const Metrics = {
  /**
   * The general-purpose duration histogram, and the target of every
   * `observe()` call and every `@Observed` method that does not name its own.
   *
   * `op` is a code constant — `ingot.materialise`, `ingot.coerce_rows` — so
   * the cardinality is the number of instrumented call sites, a number that
   * grows with the codebase rather than with traffic.
   */
  Operation: defineHistogram({
    name: 'ingot_operation_duration_seconds',
    help: 'Duration of an instrumented operation, by its declared name.',
    labels: ['op', 'outcome'],
    buckets: Buckets.Internal,
  }),

  // ── HTTP ────────────────────────────────────────────────────────────────
  /**
   * `route` is the Express route template, never the resolved path. Every
   * route in this service carries `:account` and most carry `:ingot`, so the
   * difference between the template and the path is the difference between a
   * metric and an outage.
   */
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
  /**
   * Read at scrape time rather than maintained by increments, because a gauge
   * kept by hand drifts: one early return, one exception between the two, and
   * the value is wrong in a way nothing corrects. This is the number that says
   * whether roll-up is keeping up.
   */
  OverlayRows: defineGauge({
    name: 'ingot_overlay_rows',
    help:
      'Rows sitting in the overlay, waiting to be rolled up into Parquet. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),

  // ── the read path ───────────────────────────────────────────────────────
  /**
   * Split by phase because the two fail differently and are fixed differently.
   * Materialising is bounded by how much of the base tier a query drags into
   * memory; executing is the caller's own SQL.
   */
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
  /**
   * A caller's SQL that this service refused. `reason` is our own closed set,
   * never the engine's message — the message can contain the statement.
   */
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
  /**
   * Receipts that ran out of attempts.
   *
   * Worth a series of its own rather than a share of the error rate, because
   * it is the only signal that somebody was promised a summary they will never
   * get. It should sit at zero; anything else is a query a caller is holding
   * that will always come back empty.
   */
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
  /**
   * Uploads `/file` took in, and the ones it refused at the door.
   *
   * The error half is worth watching on its own here in a way it is not for
   * `/add`. This endpoint refuses things a caller cannot see coming — a media
   * type the deployment does not parse, bytes that disagree with the type
   * declared for them, a document past the size cap — and a client integrating
   * against it will find all three at once. A step in the error rate is usually
   * somebody wiring up an uploader, not an attack.
   */
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
  /**
   * Documents that ran out of attempts.
   *
   * Apart from `pending` for the reason the receipt gauges are apart: a backlog
   * clears on its own and this does not. It should sit at zero; anything else
   * is a caller holding two queries — the document and its chunks — that will
   * both stay empty for good, and a row in `ingot_files` saying why that
   * nobody has read.
   */
  FilesAbandoned: defineGauge({
    name: 'ingot_files_abandoned',
    help:
      'Documents that failed to parse often enough that they are no longer retried. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  /**
   * The whole of one document's journey, labelled by what it was.
   *
   * `media_type` is a label because the distribution is genuinely bimodal and
   * an unlabelled histogram hides it: a Markdown file is milliseconds and a
   * three-hundred-page PDF is tens of seconds, so one series over both has a
   * p99 that describes neither.
   */
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
  /**
   * Deliveries that ran out of attempts.
   *
   * Worth a series of its own rather than a share of the error rate, and worth
   * distinguishing from an abandoned *receipt*: the data is fine here. The
   * summary is written and the SELECT the caller was handed still returns it —
   * what was lost is the telling. It should sit at zero; anything else is a
   * receiver that was promised something and never got it.
   */
  DeliveriesAbandoned: defineGauge({
    name: 'ingot_deliveries_abandoned',
    help:
      'Receipts whose delivery failed often enough that it is no longer retried. ' +
      'Deployment-wide: aggregate with max(), never sum().',
    labels: [],
  }),
  /**
   * `kind` is the transport — `webhook`, `rmq` — and never an endpoint or a
   * queue name: those are the caller's, unbounded, and sometimes carry a token.
   */
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
  /**
   * `host` is a code constant — `s3`, `openai` — never a URL, and never a
   * bucket or a tenant.
   */
  UpstreamDuration: defineHistogram({
    name: 'ingot_upstream_request_duration_seconds',
    help: 'Time for a call to an external service to return.',
    labels: ['host', 'operation', 'outcome'],
    buckets: Buckets.Upstream,
  }),
} as const;

/**
 * The gauges that report a **deployment-wide** quantity rather than this
 * process's own.
 *
 * Every one of these is read out of Postgres at scrape time, so every replica
 * answers with the same number — the depth of a queue they all share. Which
 * makes `sum()` over them wrong by exactly the replica count, and wrong in the
 * direction that matters: a backlog that looks ten times worse than it is,
 * reported by a panel nobody has reason to distrust. `max()` is the answer, and
 * `avg()` gives the same thing.
 *
 * There is no way to stop somebody writing `sum()`, so this does the next best
 * two things. It puts the instruction in the help text, which Prometheus shows
 * beside the metric; and `metric-catalogue.test.ts` requires every gauge to be
 * classified here or in `PER_PROCESS`, so a new one cannot be added without
 * somebody deciding which kind it is.
 *
 * The alternative — having only the replica that holds the sweeper's advisory
 * lock report — was considered and refused: the series would go absent every
 * time the lock moved, and a gap in a backlog gauge reads as "recovered".
 */
export const DEPLOYMENT_WIDE: readonly string[] = [
  'ingot_overlay_rows',
  'ingot_embeddings_pending',
  'ingot_receipts_pending',
  'ingot_receipts_abandoned',
  'ingot_deliveries_pending',
  'ingot_deliveries_abandoned',
  // Both read out of `file_queue` at scrape time, so every replica answers
  // with the same number — the depth of a queue they all share.
  'ingot_files_pending',
  'ingot_files_abandoned',
];

/**
 * The gauges that are genuinely this process's own, where `sum()` is right.
 *
 * Listed rather than inferred, so that "which kind is this" is a question
 * answered when a gauge is added rather than when a dashboard is wrong.
 */
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

/**
 * Why a query was refused, as a closed set.
 *
 * These are the label values on `SqlRefused`, so they are ours and finite. The
 * engine's own message is not among them: it can quote the statement back, and
 * a statement can contain anything a caller put in it.
 */
export enum RefusalReason {
  NotASelect = 'not_a_select',
  MultipleStatements = 'multiple_statements',
  DidNotParse = 'did_not_parse',
  TimedOut = 'timed_out',
  TooManyRows = 'too_many_rows',
  IngotTooLarge = 'ingot_too_large',
  EmbeddingOnly = 'embedding_only',
}
