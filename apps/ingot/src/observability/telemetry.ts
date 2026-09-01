import { Logger } from '@nestjs/common';
import { type TelemetryConfig, telemetryConfigFromEnv } from './config.js';
import { MetricsServer } from './metrics/metrics-server.js';
import { collectRuntimeMetrics, registry } from './metrics/registry.js';
import { startTracing, stopTracing } from './tracing/provider.js';

const logger = new Logger('Telemetry');
const server = new MetricsServer();
let started = false;

/**
 * Brings both signals up. Called from `main.ts` before Nest is created.
 *
 * Before, rather than from inside a module, for two reasons that pull the
 * same way: a tracer provider registered after the fact cannot retroactively
 * record the spans of the thing that started it, and a process that fails
 * during module initialisation is exactly the process whose telemetry you
 * want. What Nest owns is the other end — `ObservabilityModule` shuts this
 * down through `enableShutdownHooks`, because Nest is what knows when the pod
 * is going away.
 *
 * Nothing here can stop the API starting. A collector that is not listening,
 * a metrics port already taken — both are logged and stepped over. The
 * service's job is to serve requests; the service's telemetry failing is a
 * reason to page somebody, not a reason to take the service down with it.
 */
export async function startTelemetry(
  config: TelemetryConfig = telemetryConfigFromEnv(),
): Promise<void> {
  if (started) return;
  started = true;

  // The `service` label on every series, so one Prometheus can hold several
  // deployments of this API without their numbers merging into each other.
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
