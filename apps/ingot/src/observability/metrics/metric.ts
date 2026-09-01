import {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
} from 'prom-client';
import { currentTraceId } from '../tracing/tracer.js';
import { type MetricRegistry, registry, registryGeneration } from './registry.js';

/**
 * The label names a metric carries, fixed at declaration.
 *
 * Fixed is the point. Prometheus stores one time series per distinct label
 * combination, so a label whose values come from data rather than from code —
 * a user id, a URL, an error message — is not a dimension, it is a memory
 * leak with a scrape endpoint. Declaring the names up front means the type
 * checker can insist every call site supplies exactly these and nothing else,
 * and it makes the cardinality of a metric something you can read off its
 * declaration instead of having to audit its call sites.
 *
 * High-dimensional detail is not lost, it goes somewhere better: span
 * attributes, which are per-request and have no cardinality budget at all.
 * See `observe` in `../observe.ts` — the same call feeds both, and the split
 * between what becomes a label and what becomes an attribute is the whole
 * reason the two APIs are one API.
 */
export type LabelNames = readonly string[];

/** The label bag a metric of this shape accepts: every name, no extras. */
export type Labels<N extends LabelNames> = Record<N[number], string>;

interface Declaration<N extends LabelNames> {
  /**
   * The Prometheus name, including its unit suffix — `_seconds`, `_bytes`,
   * `_total`. `metric-catalogue.test.ts` fails on one that does not.
   */
  name: string;
  /** What it means, in a sentence. This is what a stranger reads in Grafana. */
  help: string;
  labels: N;
}

interface HistogramDeclaration<N extends LabelNames> extends Declaration<N> {
  buckets: readonly number[];
}

/**
 * A declared metric, bound to the live registry on first use.
 *
 * Declaration is a module-level constant and the registry is process state, so
 * the two are deliberately not created together: a descriptor is inert until
 * something records through it, and `resetMetrics()` in a test invalidates
 * every binding at once by bumping a generation counter. The alternative —
 * constructing prom-client metrics at import time — makes a suite that touches
 * the catalogue twice throw on the duplicate registration.
 */
abstract class Instrument<N extends LabelNames, T> {
  private bound: T | null = null;
  private generation = -1;

  // Public even though the class is abstract: `abstract` is already what
  // stops this being constructed directly, so a narrower visibility here buys
  // nothing and forces every subclass to redeclare a constructor that only
  // widens it back.
  constructor(readonly declaration: Declaration<N>) {}

  protected abstract create(into: MetricRegistry): T;

  protected get instrument(): T {
    if (this.generation !== registryGeneration()) {
      this.bound = this.create(registry());
      this.generation = registryGeneration();
    }
    // Assigned on the line above whenever the generation moved; the branch is
    // the only thing that can leave it null.
    return this.bound as T;
  }

  get name(): string {
    return this.declaration.name;
  }
}

/**
 * A monotonically increasing count — requests served, events dispatched,
 * retries spent. Never a value that can go down; that is a gauge.
 */
export class CounterMetric<N extends LabelNames> extends Instrument<N, PromCounter<string>> {
  protected create(into: MetricRegistry): PromCounter<string> {
    return new PromCounter({
      name: this.declaration.name,
      help: this.declaration.help,
      labelNames: [...this.declaration.labels],
      registers: [into],
      enableExemplars: true,
    });
  }

  inc(labels: Labels<N>, value = 1): void {
    this.instrument.inc({ labels, value, exemplarLabels: exemplar() });
  }
}

/**
 * A value that moves in both directions and is meaningful only as of now:
 * sockets connected, events waiting in the outbox, connections checked out of
 * the pool.
 *
 * Prefer `collect` over calling `set` from application code. A gauge kept up
 * to date by increments drifts the moment one code path forgets to decrement,
 * and drift in a gauge is invisible — the number is wrong but plausible.
 * Reading the truth at scrape time cannot drift.
 */
export class GaugeMetric<N extends LabelNames> extends Instrument<N, PromGauge<string>> {
  private collector: ((gauge: GaugeMetric<N>) => void | Promise<void>) | null = null;

  protected create(into: MetricRegistry): PromGauge<string> {
    const owner = this;
    return new PromGauge({
      name: this.declaration.name,
      help: this.declaration.help,
      labelNames: [...this.declaration.labels],
      registers: [into],
      async collect() {
        await owner.collector?.(owner);
      },
    });
  }

  set(labels: Labels<N>, value: number): void {
    this.instrument.set(labels, value);
  }

  inc(labels: Labels<N>, value = 1): void {
    this.instrument.inc(labels, value);
  }

  dec(labels: Labels<N>, value = 1): void {
    this.instrument.dec(labels, value);
  }

  /**
   * Reads the value at scrape time instead of tracking it.
   *
   * Called on every scrape, so it must be cheap and must not throw — a
   * collector that rejects fails the whole scrape, not just its own series.
   */
  collectWith(read: (gauge: GaugeMetric<N>) => void | Promise<void>): void {
    this.collector = read;
    // Touch the instrument so the collector is attached even if nothing has
    // recorded through this metric yet — otherwise the series only appears
    // after the first unrelated write.
    void this.instrument;
  }
}

/**
 * A distribution, always in seconds for durations.
 *
 * Seconds rather than milliseconds because Prometheus' own conventions,
 * every example query, and every Grafana panel assume base units, and a
 * dashboard mixing the two is one `rate()` away from being off by a thousand.
 */
export class HistogramMetric<N extends LabelNames> extends Instrument<N, PromHistogram<string>> {
  constructor(private readonly histogram: HistogramDeclaration<N>) {
    super(histogram);
  }

  protected create(into: MetricRegistry): PromHistogram<string> {
    return new PromHistogram({
      name: this.histogram.name,
      help: this.histogram.help,
      labelNames: [...this.histogram.labels],
      buckets: [...this.histogram.buckets],
      registers: [into],
      enableExemplars: true,
    });
  }

  observe(labels: Labels<N>, value: number): void {
    this.instrument.observe({ labels, value, exemplarLabels: exemplar() });
  }
}

/**
 * The trace this observation happened in, attached to the sample as an
 * OpenMetrics exemplar.
 *
 * This is the link that makes the two signals one system. A spike in a
 * latency panel is a number; an exemplar turns it into a trace id, and the
 * trace is the request that caused the spike. Without it, "p99 got worse"
 * and "here is a slow request" are two investigations.
 *
 * Empty when nothing is being traced — an unsampled request, tracing switched
 * off, a background loop — and prom-client then omits the exemplar rather
 * than writing an empty one.
 */
function exemplar(): Record<string, string> | undefined {
  const traceId = currentTraceId();
  return traceId ? { trace_id: traceId } : undefined;
}

export function defineCounter<const N extends LabelNames>(
  declaration: Declaration<N>,
): CounterMetric<N> {
  return new CounterMetric(declaration);
}

export function defineGauge<const N extends LabelNames>(
  declaration: Declaration<N>,
): GaugeMetric<N> {
  return new GaugeMetric(declaration);
}

export function defineHistogram<const N extends LabelNames>(
  declaration: HistogramDeclaration<N>,
): HistogramMetric<N> {
  return new HistogramMetric(declaration);
}
