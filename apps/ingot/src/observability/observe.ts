import { context } from '@opentelemetry/api';
import { Metrics } from './metrics/catalogue.js';
import type { HistogramMetric, LabelNames, Labels } from './metrics/metric.js';
import { Outcome } from './outcome.js';
import { type Detail, type Recording, markFailed, recordingFor, tracer } from './tracing/tracer.js';

/** What a measured block is: it gets a handle for detail, it returns a value. */
type Work<T> = (span: Recording) => T;

/** Told how it ended and how long it took, in seconds. */
type Recorder = (outcome: Outcome, seconds: number) => void;

/**
 * Measure a block of code: one span, one duration sample, one name.
 *
 * ```ts
 * const rows = await observe('ingot.roll_up', async (span) => {
 *   const parquet = await this.engine.compact(manifest);
 *   span.set({ 'rollup.rows': parquet.rows });
 *   return parquet.rows;
 * });
 * ```
 *
 * The name is the whole ergonomic. It becomes the span name in Jaeger *and*
 * the `op` label on `ingot_operation_duration_seconds`, so a slow operation
 * found in a Grafana panel is searchable by the same string in a trace view —
 * and the exemplar on the sample means you usually do not even have to search.
 *
 * Throwing is measured, not swallowed. The exception propagates untouched; on
 * its way past it marks the span failed and tags the sample `outcome="error"`.
 *
 * Detail may be passed up front when it is known before the work starts:
 *
 * ```ts
 * await observe('knowledge.index', { 'doc.kind': kind }, async () => …);
 * ```
 *
 * That detail lands on the span only. It never becomes a metric label, which
 * is why it can be an id, a path, or anything else per-request — see
 * `metrics/metric.ts` for why the two are kept apart.
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
 * `observe` for a block that does not await anything.
 *
 * Separate rather than overloaded because the return type is the difference
 * that matters: a synchronous caller getting a promise back is a bug that
 * typechecks, and it is exactly the bug an "either" signature would allow.
 */
export function observeSync<T>(op: string, work: Work<T>): T;
export function observeSync<T>(op: string, detail: Detail, work: Work<T>): T;
export function observeSync<T>(op: string, detailOrWork: Detail | Work<T>, maybeWork?: Work<T>): T {
  const [detail, work] = split(detailOrWork, maybeWork);
  return instrumented(op, detail, operationRecorder(op), work);
}

/**
 * `observe`, but recording into a metric you declared instead of the shared
 * operation histogram.
 *
 * Reach for this when the operation deserves labels of its own — a dimension
 * you want to group or alert by, which `op` alone cannot express:
 *
 * ```ts
 * await timed('knowledge.index', Metrics.UpstreamDuration,
 *   { host: 'turbopuffer', operation: 'upsert' },
 *   async () => this.client.upsert(vectors));
 * ```
 *
 * The metric supplies `outcome` itself, so it is the one label you do not
 * pass — and by the same token the histogram must declare it. Every
 * `*_duration_seconds` entry in the catalogue does, and
 * `metric-catalogue.test.ts` is what keeps that true.
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
 * A call to somebody else's service.
 *
 * Its own helper because external calls are where the latency and the
 * outages actually come from, and because getting them into one metric with
 * one label vocabulary is what makes "is it us or is it GitHub" a question
 * with an answer:
 *
 * ```ts
 * const repos = await upstream('github', 'list_repos', () =>
 *   this.octokit.repos.listForAuthenticatedUser());
 * ```
 *
 * `operation` is a code constant, never a URL — one series per endpoint, not
 * one per resource.
 */
export function upstream<T>(host: string, operation: string, work: Work<Promise<T>>): Promise<T> {
  return timed(`${host}.${operation}`, Metrics.UpstreamDuration, { host, operation }, work);
}

/**
 * A span with no metric behind it.
 *
 * For work that is worth seeing inside a trace but not worth a time series —
 * a step so fast that its own duration is noise, or one that appears in so
 * many shapes that an `op` label would be meaningless. The trace still shows
 * where the time went, which is usually the question being asked at that
 * depth.
 */
export function traced<T>(op: string, work: Work<Promise<T>>): Promise<T>;
export function traced<T>(op: string, detail: Detail, work: Work<Promise<T>>): Promise<T>;
export function traced<T>(
  op: string,
  detailOrWork: Detail | Work<Promise<T>>,
  maybeWork?: Work<Promise<T>>,
): Promise<T> {
  const [detail, work] = split(detailOrWork, maybeWork);
  return instrumented(op, detail, NOTHING_RECORDED, work);
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

/** For spans that are worth seeing and not worth counting. */
export const NOTHING_RECORDED: Recorder = () => {};

/**
 * Replaces a method with one that measures itself, in place.
 *
 * The shared body of `@Observed`, `@Traced` and `@Upstream` — they differ
 * only in what they record, which is the `record` argument.
 *
 * Copying the original's metadata onto the wrapper is the part that is not
 * optional. Legacy decorators are applied bottom-up, so a method written as
 *
 * ```ts
 * @Observed()
 * @Scope('repo:view')
 * @Get(':repoId')
 * findOne(…) {}
 * ```
 *
 * has `@Get` and `@Scope` stamp their metadata onto the original function
 * before this ever sees it — and a wrapper that did not carry that metadata
 * across would leave Nest with a handler that has no route and no scope. It
 * would compile, boot, and 404. Carrying it means the decorator is safe in
 * any order, which is the only way to use one people will not have to think
 * about.
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

  // A stack trace, a Nest handler name, and `route-scopes.test.ts` all read
  // this; an instrumented method should be indistinguishable from the one it
  // replaced everywhere except in a trace.
  Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true });
  // Guarded because a decorator is evaluated at module load, which can be
  // before `reflect-metadata` has been imported — and the failure then is a
  // TypeError from inside a decorator, which is a genuinely baffling thing to
  // be handed. Nothing in this process has metadata to copy at that point
  // either, so skipping is also correct.
  if (typeof Reflect.getMetadataKeys === 'function') {
    for (const key of Reflect.getMetadataKeys(original)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, original), wrapper);
    }
  }

  descriptor.value = wrapper as T;
}

/**
 * The one implementation underneath every helper above and every decorator.
 *
 * Exported because the spine uses it directly: `Dispatcher` needs a span name
 * and a metric that both depend on which command is being sent, which no
 * decorator can express and no fixed-name helper covers. Application code
 * should reach for `observe`, `timed` or `@Observed` instead — this is the
 * primitive they are made of, not a fourth way to do the same thing.
 *
 * Sync and async are handled in the same function on purpose: `@Observed` is
 * put on a method without anybody checking whether it returns a promise, so
 * the machinery has to cope with either. A thenable result defers the
 * measurement to its settlement; anything else is finished immediately.
 *
 * The span is opened *active*, which is what makes nesting work — an
 * `observe` inside an `observe` becomes a child span with no plumbing, and
 * that is the entire reason this reads as well as it does at a call site.
 */
export function instrumented<T>(
  op: string,
  detail: Detail | undefined,
  record: Recorder,
  work: Work<T>,
): T {
  const started = process.hrtime.bigint();

  return tracer().startActiveSpan(op, (span) => {
    // Captured here, where the span is unambiguously current, and restored
    // around `record` below. A promise settling several ticks later would
    // otherwise be recording an exemplar for whatever trace happened to be
    // active then — usually the right one, occasionally not, and a link that
    // is usually right is worse than no link.
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

/**
 * A metric's labels are legitimate span detail too — they are low-cardinality
 * by construction, and having them on the span means a trace search can filter
 * by the same dimension the dashboard groups by.
 */
function labelsAsDetail(labels: Readonly<Record<string, string>>): Detail {
  return { ...labels };
}

/**
 * Whether the work handed back something to wait for.
 *
 * Structural rather than `instanceof Promise`, because a handler may return a
 * thenable that is not one — a Drizzle query builder, an rxjs `firstValueFrom`
 * shim, anything with a `then`. Getting this wrong ends the span before the
 * work does, and a span that closes early is worse than no span: it reports a
 * duration, and the duration is wrong.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export type { Detail, Recording, Recorder };
