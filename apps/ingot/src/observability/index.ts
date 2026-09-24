/**
 * Ways to measure code, by scope:
 *
 * | reach                    | use                                        |
 * | ------------------------ | ------------------------------------------ |
 * | a whole method           | `@Observed()`                              |
 * | a stretch inside one     | `observe('name', async (span) => …)`        |
 * | a call to another host   | `@Upstream({…})` / `upstream(host, op, …)` |
 * | a count or a level       | `Metrics.<name>.inc(…)` / `.set(…)`        |
 *
 * The first three each produce a span and a duration sample under one name.
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
