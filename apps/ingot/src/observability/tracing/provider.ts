import { DiagLogLevel, diag } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_SERVICE_INSTANCE_ID,
} from '@opentelemetry/semantic-conventions';
import { Logger } from '@nestjs/common';
import type { TelemetryConfig } from '../config.js';

const logger = new Logger('Tracing');

let provider: NodeTracerProvider | null = null;

/**
 * Starts the trace pipeline and points it at Jaeger.
 *
 * OTLP over HTTP rather than Jaeger's own protocol, because Jaeger has spoken
 * OTLP natively since 1.35 and its Thrift/gRPC agents are deprecated. The
 * practical benefit is that the destination stops being a decision: the same
 * exporter and the same environment variable reach Jaeger, Tempo, Honeycomb
 * or an OpenTelemetry Collector, so swapping backends is a config change
 * rather than a dependency change.
 *
 * Must be called before Nest builds anything, so that spans opened during
 * module initialisation have a provider to go to.
 */
export function startTracing(config: TelemetryConfig): void {
  if (provider || !config.tracing.enabled) return;

  // Without this, an exporter that cannot reach its collector throws into
  // nothing — and on Bun an unhandled rejection from the export path takes
  // the process with it. Routing OpenTelemetry's diagnostics into Nest's
  // logger turns "the API died at 3am" into one warning line per failed
  // export, which is what a missing collector deserves.
  diag.setLogger(
    {
      error: (message) => logger.warn(`export failed: ${first(message)}`),
      warn: (message) => logger.warn(first(message)),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.ERROR,
  );

  const exporter = new OTLPTraceExporter({
    url: `${config.tracing.endpoint.replace(/\/$/, '')}/v1/traces`,
  });

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
      [ATTR_SERVICE_INSTANCE_ID]: config.instanceId,
      'deployment.environment.name': config.environment,
    }),
    /**
     * Parent-based, so the decision is made once per trace and everyone
     * downstream honours it. Sampling each service independently is how you
     * get traces with holes in them — the interesting middle span dropped
     * while its parent and child were kept.
     */
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.tracing.sampleRatio),
    }),
    /**
     * Batched rather than simple: a span per HTTP request is a lot of small
     * exports, and the request should not be waiting on any of them.
     */
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  /**
   * W3C `traceparent`, which is what makes a trace cross a process boundary —
   * the browser's fetch, this API, and anything it calls end up on one
   * timeline instead of three.
   */
  provider.register({ propagator: new W3CTraceContextPropagator() });

  logger.log(
    `Tracing ${config.serviceName} → ${config.tracing.endpoint} (sampling ${config.tracing.sampleRatio * 100}%)`,
  );
}

/**
 * Flushes what is buffered and stops.
 *
 * Worth awaiting on shutdown: a pod that exits with a full batch in memory
 * loses exactly the spans from the requests it was serving when it was told
 * to stop, which are usually the ones being asked about.
 */
export async function stopTracing(): Promise<void> {
  const running = provider;
  provider = null;
  if (!running) return;

  try {
    await running.shutdown();
  } catch (error) {
    logger.warn(`Tracing shutdown failed: ${String(error)}`);
  }
}

/** OpenTelemetry's diagnostics arrive as blobs of JSON; one line is plenty. */
function first(message: string): string {
  return message.split('\n')[0]?.slice(0, 200) ?? '';
}
