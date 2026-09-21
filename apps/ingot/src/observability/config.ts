import { section, text, textOr } from '../config/vars.js';

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
  /** The build, as `service.version`. */
  serviceVersion: string;
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
 * Anything but an explicit `false` is on.
 *
 * The asymmetry is deliberate: a typo in `TRACING_ENABLED` should leave
 * tracing on, because a mistake that silently disables observability is one
 * nobody notices until they need it.
 */
const flag = () =>
  text().transform((raw) => raw === undefined || (raw.toLowerCase() !== 'false' && raw !== '0'));

/** Out of range falls back rather than refusing: telemetry never stops a boot. */
const within = (fallback: number, min: number, max: number) =>
  text().transform((raw) => {
    const parsed = Number(raw);
    return raw === undefined || !Number.isFinite(parsed) || parsed < min || parsed > max
      ? fallback
      : parsed;
  });

/**
 * Defaults to "on, pointed at localhost".
 *
 * On by default because the failure mode of the alternative is discovering
 * during an incident that the one service you needed to look at was the one
 * where nobody set the flag. A collector that is not there costs a warning
 * line per export attempt and nothing else — `startTelemetry` makes sure of
 * that — so the default is safe even on a laptop with no Jaeger running.
 */
export const telemetryEnv = section(
  {
    OTEL_SERVICE_NAME: textOr('@ingot/server'),
    GIT_SHA: textOr('dev'),
    NODE_ENV: textOr('development'),
    HOSTNAME: text(),
    POD_NAME: text(),
    TRACING_ENABLED: flag(),
    OTEL_EXPORTER_OTLP_ENDPOINT: textOr('http://localhost:4318'),
    TRACE_SAMPLE_RATIO: within(1, 0, 1),
    METRICS_ENABLED: flag(),
    METRICS_PORT: within(9464, 1, 65_535),
    METRICS_HOST: textOr('0.0.0.0'),
  },
  (vars): TelemetryConfig => ({
    serviceName: vars.OTEL_SERVICE_NAME,
    serviceVersion: vars.GIT_SHA,
    environment: vars.NODE_ENV,
    instanceId: vars.HOSTNAME ?? vars.POD_NAME ?? `local-${process.pid}`,
    tracing: {
      enabled: vars.TRACING_ENABLED,
      endpoint: vars.OTEL_EXPORTER_OTLP_ENDPOINT,
      sampleRatio: vars.TRACE_SAMPLE_RATIO,
    },
    metrics: {
      enabled: vars.METRICS_ENABLED,
      port: vars.METRICS_PORT,
      host: vars.METRICS_HOST,
    },
  }),
);
