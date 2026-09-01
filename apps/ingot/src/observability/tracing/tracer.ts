import {
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer,
  context,
  trace,
} from '@opentelemetry/api';

/**
 * Free-form detail hung on a span: ids, counts, sizes, the name of a branch.
 *
 * Aliased rather than used under OpenTelemetry's name so that application code
 * annotating what it is doing does not read as though it has taken a
 * dependency on a tracing vendor. A span attribute is a fact about this one
 * execution — the constraint that applies to a metric label does not apply
 * here, and the whole reason `observe` takes both is to make that split the
 * obvious one.
 */
export type Detail = Attributes;

/**
 * The instrumentation scope every span this service creates is attributed to.
 * Jaeger shows it alongside the service name, which is how a span raised by
 * our own code is told apart from one raised by a library.
 */
export const TRACER_NAME = '@ingot/server';

/**
 * The tracer, resolved through the API rather than held.
 *
 * `@opentelemetry/api` hands back a no-op tracer until a provider registers,
 * and a no-op span costs a shared object and no allocation. That is what makes
 * it safe for `observe` to be called from anywhere — a unit test with no SDK
 * started, a CLI script, a deployment with tracing switched off — without
 * every call site having to check first.
 */
export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * The id of the trace currently in scope, or null when there is none.
 *
 * Read for two things: the exemplar attached to a metric sample, and the
 * `traceId` on a log line. Both are the same trick — leaving a breadcrumb in a
 * cheap signal that points into the expensive one.
 *
 * Null for an unsampled span as well as for no span at all. Recording an
 * exemplar that points at a trace the backend threw away is worse than
 * recording none: the link is there in the graph and goes nowhere.
 */
export function currentTraceId(): string | null {
  const span = trace.getSpan(context.active());
  if (!span) return null;

  const spanContext = span.spanContext();
  if (!trace.isSpanContextValid(spanContext) || !span.isRecording()) return null;
  return spanContext.traceId;
}

/**
 * What a measured block is handed.
 *
 * Deliberately small, and deliberately not the OpenTelemetry `Span`. Domain
 * and application code should be able to say what it is doing without
 * importing a vendor's API — and keeping the surface to "set an attribute,
 * note an event" also keeps people out of the parts of the span lifecycle
 * that `observe` owns. Nothing here ends a span or sets its status; that is
 * decided by whether the block threw.
 */
export interface Recording {
  /**
   * Attaches detail to the span.
   *
   * This is where high-cardinality information belongs — ids, counts, paths,
   * the name of the branch. A span carries it per-request at no cost to
   * anything else, which is precisely what a metric label cannot do.
   */
  set(detail: Detail): void;

  /** A timestamped note within the span: a retry, a cache miss, a fallback taken. */
  event(name: string, detail?: Detail): void;
}

/** Wraps a span in the narrow surface application code is given. */
export function recordingFor(span: Span): Recording {
  return {
    set(detail) {
      span.setAttributes(detail);
    },
    event(name, detail) {
      span.addEvent(name, detail);
    },
  };
}

/**
 * Marks a span as failed and attaches the exception.
 *
 * Both halves matter and they are separate calls in the OpenTelemetry API:
 * `recordException` puts the stack trace on the span as an event, and
 * `setStatus` is what makes the span show up red and turns it into an error
 * count in Jaeger. Doing only the first leaves a trace that contains the
 * exception and does not look like it failed.
 */
export function markFailed(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.setAttribute('error.type', error.constructor.name);
    return;
  }
  const message = String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.setAttribute('error.type', 'unknown');
}
