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
 * Starts the OTLP/HTTP trace pipeline. Must be called before Nest builds
 * anything, so spans opened during startup have a provider.
 */
export function startTracing(config: TelemetryConfig): void {
  if (provider || !config.tracing.enabled) return;

  // Route OpenTelemetry's diagnostics into Nest's logger; otherwise a failed export can throw into nothing.
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
    // Parent-based: the sampling decision is made once per trace and honoured downstream.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.tracing.sampleRatio),
    }),
    // Batched so a request never waits on a span export.
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  // W3C `traceparent` propagation, so a trace crosses process boundaries.
  provider.register({ propagator: new W3CTraceContextPropagator() });

  logger.log(
    `Tracing ${config.serviceName} → ${config.tracing.endpoint} (sampling ${config.tracing.sampleRatio * 100}%)`,
  );
}

/** Flushes buffered spans and stops. */
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
