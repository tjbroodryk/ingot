/** Telemetry export settings, parsed once from the environment. */
export interface TelemetryConfig {
  /** The `service.name` on every span and the `service` label on every metric. */
  serviceName: string;
  /** `production`, `staging`, `development`. */
  environment: string;
  instanceId: string;

  tracing: {
    enabled: boolean;
    /** OTLP/HTTP collector root; the signal path (`/v1/traces`) is appended. */
    endpoint: string;
    /** Fraction of root traces kept, 0 to 1. */
    sampleRatio: number;
  };

  metrics: {
    enabled: boolean;
    /** Port for the standalone scrape listener. */
    port: number;
    host: string;
  };
}

/** Reads the config from the environment, defaulting to on and pointed at localhost. */
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

/** Anything but an explicit `false` or `0` is on. */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() !== 'false' && value !== '0';
}

function ratio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}
