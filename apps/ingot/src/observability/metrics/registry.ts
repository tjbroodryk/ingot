import { type OpenMetricsContentType, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * The registry is bound to OpenMetrics at the type level, not just at runtime.
 * prom-client makes the content type a type parameter precisely so that
 * `setContentType` cannot be handed one the registry was not built for.
 */
export type MetricRegistry = Registry<OpenMetricsContentType>;

/**
 * The prefix every metric this service exports carries.
 *
 * One namespace per service is what keeps a shared Prometheus legible: a
 * panel can ask for `ingot_*` and get this service's view of itself rather
 * than whatever else happens to be scraped into the same store. `@forge/api`
 * exports `forge_*` from its own registry; the two are scraped together and
 * must not collide.
 */
export const METRIC_PREFIX = 'ingot_';

let current = fresh();
let generation = 0;

/**
 * OpenMetrics rather than the older text format, because exemplars only exist
 * there — prom-client refuses to construct an exemplar-enabled metric against
 * a plain registry. Prometheus picks its parser from the response
 * `Content-Type`, so serving this unconditionally is safe for any scraper that
 * did not ask for it; the exemplars are simply ignored by one that cannot read
 * them. Storing them needs `--enable-feature=exemplar-storage`, which
 * `docker/prometheus.yml` documents.
 */
function fresh(): MetricRegistry {
  const created = new Registry<OpenMetricsContentType>();
  created.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
  return created;
}

/** The registry every declared metric binds itself to. */
export function registry(): MetricRegistry {
  return current;
}

/**
 * Bumped whenever the registry is replaced, so a declared metric can tell that
 * the instrument it cached belongs to a registry nobody scrapes any more.
 */
export function registryGeneration(): number {
  return generation;
}

/**
 * The Node runtime's own numbers: heap, event loop lag, GC pauses, file
 * descriptors, resident memory.
 *
 * Worth having before any of the application metrics, because they answer the
 * first question of most incidents — is the service slow, or is the process
 * unwell — and no amount of domain instrumentation substitutes for an event
 * loop lag graph.
 */
export function collectRuntimeMetrics(): void {
  collectDefaultMetrics({ register: current, prefix: METRIC_PREFIX });
}

/**
 * Throws away every recorded sample and every binding.
 *
 * For tests. A suite that asserted on a counter would otherwise be reading a
 * number the previous test contributed to, and the failure — an assertion
 * that passes alone and fails in a run — is a bad afternoon.
 */
export function resetMetrics(): void {
  current.clear();
  current = fresh();
  generation += 1;
}
