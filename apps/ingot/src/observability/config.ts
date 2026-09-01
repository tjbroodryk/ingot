/**
 * What this deployment exports, and to where.
 *
 * Parsed once from the environment and passed down, rather than read at the
 * point of use. Telemetry that reconfigures itself halfway through a process
 * is worse than telemetry that is off — a gap in a graph reads as an outage.
 */
export interface TelemetryConfig {
  /** The `service.name` on every span and the `service` label on every metric. */
  serviceName: string;
  /** Deployment environment — `production`, `staging`, a developer's laptop. */
  environment: string;
  /** This process, so one pod's numbers can be told from another's. */
  instanceId: string;

  tracing: {
    enabled: boolean;
    /**
     * The OTLP/HTTP collector root — Jaeger's own, or a collector in front of
     * it. The signal path is appended (`/v1/traces`), which is the convention
     * every OTLP backend follows and what `OTEL_EXPORTER_OTLP_ENDPOINT` means
     * in the specification.
     */
    endpoint: string;
    /** Fraction of root traces kept, 0 to 1. */
    sampleRatio: number;
  };

  metrics: {
    enabled: boolean;
    /** Its own listener, off the product surface. See `metrics-server.ts`. */
    port: number;
    host: string;
  };
}

/**
 * Reads the environment, defaulting to "on, pointed at localhost".
 *
 * On by default because the failure mode of the alternative is discovering
 * during an incident that the one service you needed to look at was the one
 * where nobody set the flag. A collector that is not there costs a warning
 * line per export attempt and nothing else — `startTelemetry` makes sure of
 * that — so the default is safe even on a laptop with no Jaeger running.
 */
export function telemetryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  return {
    serviceName: env.OTEL_SERVICE_NAME ?? '@ingot/server',
    environment: env.NODE_ENV ?? 'development',
    instanceId: env.HOSTNAME ?? env.POD_NAME ?? `local-${process.pid}`,
    tracing: {
      enabled: flag(env.TRACING_ENABLED, true),
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
      sampleRatio: ratio(env.TRACE_SAMPLE_RATIO, 1),
    },
    metrics: {
      enabled: flag(env.METRICS_ENABLED, true),
      port: Number(env.METRICS_PORT ?? 9464),
      host: env.METRICS_HOST ?? '0.0.0.0',
    },
  };
}

/**
 * Anything but an explicit `false` is on.
 *
 * The asymmetry is deliberate: a typo in `TRACING_ENABLED` should leave
 * tracing on, because a mistake that silently disables observability is one
 * nobody notices until they need it.
 */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() !== 'false' && value !== '0';
}

function ratio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}
