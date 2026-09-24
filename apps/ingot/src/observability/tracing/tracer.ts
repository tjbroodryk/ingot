import {
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer,
  context,
  trace,
} from '@opentelemetry/api';

/**
 * Free-form detail hung on a span: ids, counts, sizes. Aliased to keep the
 * vendor name out of application code.
 */
export type Detail = Attributes;

/** Instrumentation scope every span this service creates is attributed to. */
export const TRACER_NAME = '@ingot/server';

/** The tracer, resolved through the API each call; a no-op until a provider registers. */
export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** The id of the trace currently in scope, or null. Also null for an unsampled span, not just no span. */
export function currentTraceId(): string | null {
  const span = trace.getSpan(context.active());
  if (!span) return null;

  const spanContext = span.spanContext();
  if (!trace.isSpanContextValid(spanContext) || !span.isRecording()) return null;
  return spanContext.traceId;
}

/**
 * The narrow surface a measured block is handed; not the OpenTelemetry `Span`.
 * Cannot end a span or set its status — that follows from whether the block threw.
 */
export interface Recording {
  /** Attaches detail to the span; where high-cardinality information belongs. */
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
 * Marks a span failed and attaches the exception: `recordException` for the
 * stack trace, `setStatus` for the error status.
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
