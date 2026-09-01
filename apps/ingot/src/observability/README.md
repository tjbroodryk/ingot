# Observability

Metrics to Prometheus, traces to Jaeger, and one vocabulary over both.

```bash
bun run obs:up   # Jaeger on :16686, Prometheus on :9090
bun run dev      # the API, exporting to both
```

## The one thing to know

**A name is a span name and a metric label at the same time.**

```ts
await observe('ingot.roll_up', async (span) => { … });
```

That produces a span called `ingot.roll_up` in Jaeger _and_ a sample on
`ingot_operation_duration_seconds{op="ingot.roll_up"}` in Prometheus. When a
panel shows that operation getting slower, the same string finds the traces —
and the exemplar on the sample means you usually do not even have to search,
because the bucket carries the trace id of a request that landed in it.

Everything else in this directory exists to keep that property true.

## What is already measured

Nothing needs opting in for the spine. Every one of these is instrumented at
the single place all of its traffic passes through:

| what             | where it is instrumented        | metric                                                    |
| ---------------- | ------------------------------- | --------------------------------------------------------- |
| HTTP requests    | `http/telemetry.middleware.ts`  | `ingot_http_request_duration_seconds`, `…_in_flight`      |
| Commands         | `shared/application/dispatcher` | `ingot_command_duration_seconds`                          |
| Queries          | `shared/application/dispatcher` | `ingot_query_duration_seconds`                            |
| Writes           | `records/…/add-records.command` | `ingot_rows_ingested_total`, `ingot_overlay_rows`         |
| DuckDB sessions  | `engine/duckdb-engine.ts`       | `ingot_query_session_duration_seconds`, `…_rows_returned` |
| Refused SQL      | `engine/duckdb-engine.ts`       | `ingot_sql_refused_total`                                 |
| Roll-up          | `sweepers`                      | `ingot_compaction_duration_seconds`, `ingot_rows_compacted_total` |
| Embeddings       | `sweepers`, `ai/`               | `ingot_embeddings_pending`, `ingot_embedding_duration_seconds` |
| Receipts         | `records/…/receipt-worker.ts`   | `ingot_receipts_pending`, `…_abandoned`, `ingot_receipt_duration_seconds` |
| Transactions     | `pg-unit-of-work`               | `ingot_transaction_duration_seconds`                      |
| Connection pool  | `infrastructure-collectors`     | `ingot_db_pool_connections`                               |
| Model calls      | `ai/`                           | `ingot_upstream_request_duration_seconds`                 |
| The Node process | `metrics/registry.ts`           | `ingot_process_*`, `ingot_nodejs_*`                       |

`metrics/catalogue.ts` is the list, and `test/observability/metric-catalogue.test.ts`
is what keeps this table from being the second answer to the same question.

A request arriving at `/api/v1/:account/:ingot/query` produces this in Jaeger
with nobody having annotated anything:

```
POST /api/v1/:account/:ingot/query  http.route, status
└─ query.QueryIngot                 cqrs.kind=query
```

The dispatcher is where the CQRS instrumentation lives for the same reason the
transaction is: it is the one place every command and query passes through, so
a handler cannot forget.

## Instrumenting your own code

Four things, and the choice between them is about scope, not about signals.

**A whole method** — `@Observed`:

```ts
class DuckDbEngine {
  @Observed({ op: 'ingot.query' })
  async query(plan: QueryPlan): Promise<QueryResult> { … }
}
```

Name it explicitly. The default is `Class.method`, which is accurate and
fragile — it changes when someone renames the class, taking the dashboard
panel and the alert rule with it.

**A stretch inside a method** — `observe`:

```ts
async rollUp(table: IngotTable): Promise<Generation> {
  const rows = await observe('rollup.drain', { 'ingot.id': table.ingotId }, async (span) => {
    const overlay = await this.overlay.take(table);
    span.set({ 'rollup.rows': overlay.length });
    return overlay;
  });

  return observe('rollup.write', async () => this.engine.writeParquet(table, rows));
}
```

Blocks nest into spans with no plumbing — an `observe` inside an `observe` is a
child span, and inside a command handler it is a child of `command.Analyse`,
which is a child of the HTTP request.

`observeSync` is the same for work that awaits nothing. It is a separate
function rather than an overload because a synchronous caller handed a promise
back is a bug that typechecks.

**A call to somebody else's service** — `@Upstream` / `upstream`:

```ts
const token = await upstream('gcs', 'access_token', () =>
  this.auth.getAccessToken(),
);
```

Its own metric with wider buckets, because external latency runs to tens of
seconds and the shape of that tail is the argument for a circuit breaker. It is
also what makes "is it us or is it the bucket" a question with an answer — and
the same for the embedding and summarisation models, which are the other two
things here that can be slow without being broken.

**A count or a level** — declare it in `metrics/catalogue.ts` and record
directly:

```ts
Metrics.RowsIngested.inc({ outcome: Outcome.Ok }, rows.length);
```

Labels are typed from the declaration, so a missing or misspelled one is a
compile error rather than a series nobody notices is wrong.

Need a duration histogram with labels of its own? `timed` takes one and
supplies the `outcome` itself:

```ts
await timed(
  'knowledge.upsert',
  Metrics.UpstreamDuration,
  { host: 'turbopuffer', operation: 'upsert' },
  async () => this.client.upsert(vectors),
);
```

And `traced` opens a span with no time series behind it, for work worth seeing
inside a trace but not worth a series of its own.

## Labels and attributes are not the same thing

This is the distinction the whole design rests on, and the one that goes wrong
in every codebase that has not thought about it.

|                 | metric label                                               | span attribute                                      |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| lives in        | Prometheus, for the retention                              | one trace                                           |
| cost of a value | a new time series, forever                                 | nothing                                             |
| may be          | a closed set — a route template, an event type, an outcome | anything — an id, a path, a count, an error message |

Prometheus stores one series per distinct label combination. A label whose
values come from data rather than from code is not a dimension, it is a memory
leak with a scrape endpoint — and it grows slowly enough that nobody connects
the eventual outage to the decision.

So the two APIs are one API deliberately: `observe(op, detail, work)` puts
`detail` on the span and never on a label. Per-request specificity is not lost,
it goes where it is free.

The rules are held by `test/observability/metric-catalogue.test.ts` rather than
by review — naming, unit suffixes, help text, ascending buckets, and a
four-label cardinality budget you have to justify exceeding.

## Configuration

Everything is on by default, pointed at localhost. See `.env.example`.

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # Jaeger, Tempo, a collector
TRACE_SAMPLE_RATIO=1                                # parent-based
METRICS_PORT=9464                                   # its own listener
```

Anything but an explicit `false` leaves a flag on. The asymmetry is deliberate:
the version of a typo that silently disables observability is the one nobody
notices until they need it.

Two failure modes are handled rather than propagated, because a service's
telemetry failing is a reason to page someone and not a reason to take the
service down:

- **No collector.** Export failures are routed through OpenTelemetry's `diag`
  into Nest's logger — one warning per failed batch. Without that, on Bun, an
  unhandled rejection from the export path takes the process with it.
- **The metrics port is taken.** Logged, stepped over, API starts.

### Why `/metrics` is on its own port

It is a complete inventory of what this service does and how often: route
names, event types, upstream hosts, error rates. That belongs to the cluster,
not to the internet. Its own listener means it cannot be reached through the
public ingress even if someone misconfigures one, and there is no
`@Scope('public:any')` hole in a guard that is otherwise fail-closed.

Bind it to the pod network. `METRICS_HOST` defaults to `0.0.0.0` because a
container needs to be reachable from the node; a network policy is what makes
that safe.

### Why OpenMetrics

Exemplars only exist in that format — prom-client refuses to construct an
exemplar-enabled metric against a plain registry. Prometheus picks its parser
from the response `Content-Type`, so serving it unconditionally is safe for a
scraper that did not ask; it just ignores what it cannot read. _Storing_
exemplars needs `--enable-feature=exemplar-storage`, which `docker/prometheus.yml`
already passes.

## Known gap: background work is its own trace

This gap used to be a cross-process one — the work was invoked back by Restate,
arriving on a listener that `telemetry.middleware.ts` never saw, so the
`traceparent` of the request that queued it was gone by definition. That is no
longer the shape of it: `/add` wakes `EmbedWorker` and `ReceiptWorker` in this
process, from `uow.afterCommit`.

What remains is smaller and has two halves.

A **woken drain** is deliberately detached — `BackgroundWork.wake` returns
immediately and nobody awaits it, because the caller's response has already
gone. So its spans hang off a request span that may well have ended, which is
not a parent relationship worth drawing. A span link from the drain to the write
that woke it is the right shape and is not built.

A **swept drain** has no parent at all, and that is correct rather than missing:
a tick is started by a timer, and inventing a parent for it would be worse than
having none.

Both are findable either way: the queue row carries the ingot and the batch, and
the spans carry the same ids. Called out here rather than done quietly.

## Testing

`test/observability/` runs against a real tracer and a real registry, because
the property under test is that a span and a sample come out of one call and
agree with each other — a double that recorded "observe was called" would pass
whether or not that were true.

- `metric-catalogue.test.ts` — the naming and cardinality rules, mechanically:
  every metric carries the `ingot_` prefix, every histogram ends
  `_seconds`, every counter `_total`, and no label is one an account or an
  ingot id could make unbounded. It is the whole of the coverage here, and the
  reason the table above can be trusted.

Two things worth knowing if you extend it. Legacy decorators apply bottom-up,
so an `@Observed` above `@Get()` replaces a function Nest has already stamped a
route onto — `observed.decorator.ts` copies the metadata across, and without
that it compiles, boots, and 404s. And the HTTP middleware's route label is a
template rather than a path, which is a property of where it sits in Nest's
pipeline: anything asserting on it has to go through a real server.
- `spine.test.ts` — that a command nobody annotated is measured anyway.

Use `resetMetrics()` between tests. A suite asserting on a counter otherwise
reads a number the previous test contributed to, and a test that passes alone
and fails in a run is a bad afternoon.
