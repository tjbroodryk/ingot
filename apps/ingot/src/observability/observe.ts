import { context } from '@opentelemetry/api';
import { Metrics } from './metrics/catalogue.js';
import type { HistogramMetric, LabelNames, Labels } from './metrics/metric.js';
import { Outcome } from './outcome.js';
import { type Detail, type Recording, markFailed, recordingFor, tracer } from './tracing/tracer.js';

/** A measured block: given a handle for detail, returns a value. */
type Work<T> = (span: Recording) => T;

/** Told how it ended and how long it took, in seconds. */
type Recorder = (outcome: Outcome, seconds: number) => void;

/**
 * Measure a block of code: one span, one duration sample, one name. The name
 * becomes both the span name and the `op` label. A throw is measured (span
 * failed, `outcome="error"`) and re-thrown untouched.
 *
 * ```ts
 * const rows = await observe('ingot.roll_up', async (span) => {
 *   const parquet = await this.engine.compact(manifest);
 *   span.set({ 'rollup.rows': parquet.rows });
 *   return parquet.rows;
 * });
 * ```
 *
 * Detail passed up front (`observe(op, detail, work)`) lands on the span only,
 * never as a metric label.
 */
export function observe<T>(op: string, work: Work<Promise<T>>): Promise<T>;
export function observe<T>(op: string, detail: Detail, work: Work<Promise<T>>): Promise<T>;
export function observe<T>(
  op: string,
  detailOrWork: Detail | Work<Promise<T>>,
  maybeWork?: Work<Promise<T>>,
): Promise<T> {
  const [detail, work] = split(detailOrWork, maybeWork);
  return instrumented(op, detail, operationRecorder(op), work);
}

/**
 * `observe`, but recording into a caller-declared histogram instead of the
 * shared operation one — for operations that need labels of their own. The
 * metric supplies `outcome`, so it is the one label not passed (and must be declared).
 *
 * ```ts
 * await timed('ingot.embed', Metrics.UpstreamDuration,
 *   { host: 'openai', operation: 'embeddings' },
 *   async () => this.client.embeddings.create(request));
 * ```
 */
export function timed<T, N extends LabelNames>(
  op: string,
  metric: HistogramMetric<N>,
  labels: Omit<Labels<N>, 'outcome'>,
  work: Work<Promise<T>>,
): Promise<T> {
  return instrumented(op, labelsAsDetail(labels), outcomeRecorder(metric, labels), work);
}

/**
 * A call to an external service, recorded into `UpstreamDuration`.
 *
 * ```ts
 * const vectors = await upstream('openai', 'embeddings', () =>
 *   this.client.embeddings.create(request));
 * ```
 *
 * `operation` is a code constant, never a URL.
 */
export function upstream<T>(host: string, operation: string, work: Work<Promise<T>>): Promise<T> {
  return timed(`${host}.${operation}`, Metrics.UpstreamDuration, { host, operation }, work);
}

/** Records into the shared operation histogram under this name. */
export function operationRecorder(op: string): Recorder {
  return (outcome, seconds) => {
    Metrics.Operation.observe({ op, outcome }, seconds);
  };
}

/** Records into a caller-declared histogram, supplying the outcome. */
export function outcomeRecorder<N extends LabelNames>(
  metric: HistogramMetric<N>,
  labels: Omit<Labels<N>, 'outcome'>,
): Recorder {
  return (outcome, seconds) => {
    metric.observe({ ...labels, outcome } as Labels<N>, seconds);
  };
}

/**
 * Replaces a method with one that measures itself, in place. The shared body of
 * `@Observed` and `@Upstream`, which differ only in `record`.
 *
 * Copies the original's metadata onto the wrapper so decorators like `@Post` and
 * `@AccountScope` applied underneath keep working regardless of order.
 */
export function instrumentMethod<T extends (...args: never[]) => unknown>(
  descriptor: TypedPropertyDescriptor<T>,
  op: string,
  detail: Detail | undefined,
  record: Recorder,
): void {
  const original = descriptor.value;
  if (typeof original !== 'function') {
    throw new Error(`Cannot instrument "${op}": it is a property, not a method`);
  }

  const wrapper = function (this: unknown, ...args: never[]): unknown {
    return instrumented(op, detail, record, () => original.apply(this, args) as unknown);
  };

  // Keep the original name for stack traces and Nest handler resolution.
  Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true });
  // Guarded: a decorator can run before `reflect-metadata` is imported, when there is nothing to copy anyway.
  if (typeof Reflect.getMetadataKeys === 'function') {
    for (const key of Reflect.getMetadataKeys(original)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, original), wrapper);
    }
  }

  descriptor.value = wrapper as T;
}

/**
 * The one implementation underneath every helper and decorator here. Handles
 * sync and async work: a thenable defers measurement to its settlement, anything
 * else is finished on return. The span is opened active, so nested calls become
 * child spans.
 */
export function instrumented<T>(
  op: string,
  detail: Detail | undefined,
  record: Recorder,
  work: Work<T>,
): T {
  const started = process.hrtime.bigint();

  return tracer().startActiveSpan(op, (span) => {
    // Captured here where the span is current, restored around `record`, so a
    // late-settling promise records the exemplar for this trace, not whatever is active then.
    const active = context.active();
    if (detail) span.setAttributes(detail);

    const finish = (outcome: Outcome, error?: unknown): void => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      if (outcome === Outcome.Error) markFailed(span, error);
      context.with(active, () => record(outcome, seconds));
      span.end();
    };

    let result: T;
    try {
      result = work(recordingFor(span));
    } catch (error) {
      finish(Outcome.Error, error);
      throw error;
    }

    if (!isThenable(result)) {
      finish(Outcome.Ok);
      return result;
    }

    return result.then(
      (value) => {
        finish(Outcome.Ok);
        return value;
      },
      (error: unknown) => {
        finish(Outcome.Error, error);
        throw error;
      },
    ) as T;
  });
}

/** Distinguishes `observe(op, work)` from `observe(op, detail, work)`. */
function split<T>(
  detailOrWork: Detail | Work<T>,
  maybeWork: Work<T> | undefined,
): [Detail | undefined, Work<T>] {
  return typeof detailOrWork === 'function'
    ? [undefined, detailOrWork]
    : [detailOrWork, maybeWork as Work<T>];
}

/** A metric's labels are valid span detail too, so a trace search can filter by them. */
function labelsAsDetail(labels: Readonly<Record<string, string>>): Detail {
  return { ...labels };
}

/** Whether the work returned a thenable; structural because it may not be a real `Promise`. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export type { Detail, Recording, Recorder };
