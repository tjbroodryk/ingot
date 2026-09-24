import { Logger } from '@nestjs/common';
import { type TelemetryConfig, telemetryConfigFromEnv } from './config.js';
import { MetricsServer } from './metrics/metrics-server.js';
import { collectRuntimeMetrics, registry } from './metrics/registry.js';
import { startTracing, stopTracing } from './tracing/provider.js';

const logger = new Logger('Telemetry');
const server = new MetricsServer();
let started = false;

/**
 * Brings both signals up. Called from `main.ts` before Nest is created, so
 * spans from startup have a provider. Failures are logged and stepped over
 * rather than stopping the API.
 */
export async function startTelemetry(
  config: TelemetryConfig = telemetryConfigFromEnv(),
): Promise<void> {
  if (started) return;
  started = true;

  // Default labels on every series, identifying this process.
  registry().setDefaultLabels({
    service: config.serviceName,
    environment: config.environment,
    instance: config.instanceId,
  });

  startTracing(config);

  if (config.metrics.enabled) {
    collectRuntimeMetrics();
    try {
      await server.start(config.metrics.host, config.metrics.port);
    } catch (error) {
      logger.error(`Metrics endpoint could not start: ${String(error)}`);
    }
  }
}

/** Stops the scrape endpoint and flushes buffered spans. Idempotent. */
export async function stopTelemetry(): Promise<void> {
  if (!started) return;
  started = false;
  await Promise.all([server.stop(), stopTracing()]);
}
