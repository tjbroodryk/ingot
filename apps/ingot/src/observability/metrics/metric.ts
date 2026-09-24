import {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
} from 'prom-client';
import { currentTraceId } from '../tracing/tracer.js';
import { type MetricRegistry, registry, registryGeneration } from './registry.js';

/**
 * The label names a metric carries, fixed at declaration. Values must be a
 * closed set from code, never from data; high-cardinality detail goes on the span.
 */
export type LabelNames = readonly string[];

/** The label bag a metric of this shape accepts: every name, no extras. */
export type Labels<N extends LabelNames> = Record<N[number], string>;

interface Declaration<N extends LabelNames> {
  /** The Prometheus name, including its unit suffix (`_seconds`, `_bytes`, `_total`). */
  name: string;
  /** What it means, in a sentence. */
  help: string;
  labels: N;
}

interface HistogramDeclaration<N extends LabelNames> extends Declaration<N> {
  buckets: readonly number[];
}

/**
 * A declared metric, bound to the live registry on first use and rebound
 * whenever `resetMetrics()` bumps the generation counter.
 */
abstract class Instrument<N extends LabelNames, T> {
  private bound: T | null = null;
  private generation = -1;

  // Public: `abstract` already blocks direct construction.
  constructor(readonly declaration: Declaration<N>) {}

  protected abstract create(into: MetricRegistry): T;

  protected get instrument(): T {
    if (this.generation !== registryGeneration()) {
      this.bound = this.create(registry());
      this.generation = registryGeneration();
    }
    // Set by the branch above whenever the generation moved.
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
 * A value that moves in both directions, meaningful only as of now. Prefer
 * `collectWith` over calling `set` from application code, which drifts.
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

  /** Reads the value at scrape time. Called on every scrape, so must be cheap and must not throw. */
  collectWith(read: (gauge: GaugeMetric<N>) => void | Promise<void>): void {
    this.collector = read;
    // Touch the instrument so the collector attaches even before any write.
    void this.instrument;
  }
}

/** A distribution, always in seconds for durations (Prometheus base units). */
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
 * The current trace id as an OpenMetrics exemplar, linking the sample to its
 * trace. Undefined when nothing is being traced, so prom-client omits it.
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
