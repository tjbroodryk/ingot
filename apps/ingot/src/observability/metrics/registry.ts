import { type OpenMetricsContentType, Registry, collectDefaultMetrics } from 'prom-client';

/** Registry bound to OpenMetrics at the type level. */
export type MetricRegistry = Registry<OpenMetricsContentType>;

/** The prefix every metric this service exports carries. */
export const METRIC_PREFIX = 'ingot_';

let current = fresh();
let generation = 0;

/** A registry using OpenMetrics, the format exemplars require. */
function fresh(): MetricRegistry {
  const created = new Registry<OpenMetricsContentType>();
  created.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
  return created;
}

/** The registry every declared metric binds itself to. */
export function registry(): MetricRegistry {
  return current;
}

/** Bumped whenever the registry is replaced, so cached instruments know to rebind. */
export function registryGeneration(): number {
  return generation;
}

/** Registers the Node runtime's own metrics: heap, event loop lag, GC, file descriptors, memory. */
export function collectRuntimeMetrics(): void {
  collectDefaultMetrics({ register: current, prefix: METRIC_PREFIX });
}

/** Throws away every recorded sample and every binding. */
export function resetMetrics(): void {
  current.clear();
  current = fresh();
  generation += 1;
}
