/**
 * Measuring anything in this service goes through one of four things, and the
 * choice between them is a question about scope rather than about signals:
 *
 * | reach                    | use                                        |
 * | ------------------------ | ------------------------------------------ |
 * | a whole method           | `@Observed()`                              |
 * | a stretch inside one     | `observe('name', async (span) => …)`        |
 * | a call to another host   | `@Upstream({…})` / `upstream(host, op, …)` |
 * | a count or a level       | `Metrics.<name>.inc(…)` / `.set(…)`        |
 *
 * The first three all produce a span *and* a duration sample under one name,
 * which is the property worth protecting: an operation found to be slow on a
 * Grafana panel is searchable by the same string in Jaeger, and the exemplar
 * on the sample usually saves even that search.
 *
 * The spine is already instrumented and nothing needs to opt in — every HTTP
 * request, command, query, domain event, transaction and outbox cycle is
 * measured where it passes through the one place all of them pass through.
 * What is left for these is the work underneath: an adapter calling a code
 * host, an expensive step inside a handler, a queue depth worth watching.
 *
 * See `README.md` in this directory for the whole picture, including which
 * detail belongs on a label and which belongs on a span.
 */
export { telemetryConfigFromEnv, type TelemetryConfig } from './config.js';
export { InfrastructureCollectors } from './infrastructure-collectors.js';
export { Metrics, PoolState, RefusalReason } from './metrics/catalogue.js';
export { Buckets } from './metrics/buckets.js';
export {
  defineCounter,
  defineGauge,
  defineHistogram,
  type CounterMetric,
  type GaugeMetric,
  type HistogramMetric,
  type LabelNames,
  type Labels,
} from './metrics/metric.js';
export { METRIC_PREFIX, registry, resetMetrics } from './metrics/registry.js';
export {
  instrumented,
  observe,
  observeSync,
  operationRecorder,
  outcomeRecorder,
  timed,
  traced,
  upstream,
  type Recorder,
} from './observe.js';
export { Observed, Traced, Upstream, type ObservedOptions } from './observed.decorator.js';
export { ObservabilityModule } from './observability.module.js';
export { Outcome } from './outcome.js';
export { startTelemetry, stopTelemetry } from './telemetry.js';
export { currentTraceId, type Detail, type Recording } from './tracing/tracer.js';
