import { describe, expect, it } from 'bun:test';
import {
  DEPLOYMENT_WIDE,
  Metrics,
  PER_PROCESS,
} from '../../src/observability/metrics/catalogue.js';
import { METRIC_PREFIX } from '../../src/observability/metrics/registry.js';

/**
 * The naming and cardinality rules, held mechanically.
 *
 * A metric's cost is not paid where it is recorded — it is paid in the store,
 * for the whole retention window — so the rules that keep it affordable cannot
 * be enforced at the call site. They are enforced here, over the one file that
 * declares them all.
 */
interface Declared {
  name: string;
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
}

/**
 * A declaration is inert until something records through it — see
 * `metric.ts` — so the spec lives on `.declaration` rather than on the
 * instrument, and that is what this reads.
 */
const declared = Object.entries(Metrics).map(
  ([key, metric]) => [key, (metric as { declaration: Declared }).declaration] as const,
);

/**
 * Histograms whose unit is not time, with the reason.
 *
 * A list rather than a loosened rule, so that adding one is a visible edit
 * here: "every histogram is in seconds" is right often enough that the
 * exceptions are worth naming.
 */
const NOT_SECONDS: Readonly<Record<string, string>> = {
  ingot_query_rows_returned: 'Counts rows in a result, which have no unit suffix.',
};

describe('the metric catalogue', () => {
  it('declares some metrics', () => {
    expect(declared.length).toBeGreaterThan(5);
  });

  it.each(declared)('%s is namespaced to this service', (_key, metric) => {
    // `@forge/api` exports `forge_*` from its own registry and the two are
    // scraped together. A collision would silently merge two services' series.
    expect(metric.name.startsWith(METRIC_PREFIX)).toBe(true);
    expect(METRIC_PREFIX).toBe('ingot_');
  });

  it.each(declared)('%s ends in its unit', (_key, metric) => {
    const unit = /(_seconds|_total|_bytes)$/.exec(metric.name)?.[1];
    const isHistogram = Array.isArray(metric.buckets);

    if (isHistogram && !(metric.name in NOT_SECONDS)) {
      expect({ name: metric.name, unit }).toEqual({ name: metric.name, unit: '_seconds' });
    }
    // A counter ends `_total`; a gauge of things ends in neither.
    if (unit === '_total') expect(isHistogram).toBe(false);
  });

  it.each(declared)('%s has help text that reads as a sentence', (_key, metric) => {
    expect(metric.help.length).toBeGreaterThan(15);
    expect(metric.help.endsWith('.')).toBe(true);
    expect(metric.help[0]).toBe(metric.help[0]?.toUpperCase());
  });

  it.each(declared)('%s stays inside the cardinality budget', (_key, metric) => {
    expect(metric.labels.length).toBeLessThanOrEqual(4);
  });

  /**
   * The rule this service needs most.
   *
   * It is multi-tenant, so a label carrying an account, an ingot or a table
   * name is one series per tenant per table, kept for the whole retention
   * window — a slow leak that looks fine until it is the reason Prometheus
   * fell over. Per-tenant detail belongs on the span, where `observe(op,
   * detail, work)` puts it and where it costs nothing.
   */
  it.each(declared)('%s carries no tenant identity on a label', (_key, metric) => {
    const forbidden = ['account', 'ingot', 'table', 'id', 'key', 'user', 'slug', 'row_id'];
    const offending = metric.labels.filter((label) =>
      forbidden.some((word) => label.toLowerCase().includes(word)),
    );
    expect({ name: metric.name, offending }).toEqual({ name: metric.name, offending: [] });
  });

  it.each(declared.filter(([, metric]) => Array.isArray(metric.buckets)))(
    '%s has ascending buckets',
    (_key, metric) => {
      const buckets = metric.buckets ?? [];
      for (let at = 1; at < buckets.length; at++) {
        expect(buckets[at]).toBeGreaterThan(buckets[at - 1] as number);
      }
    },
  );

  it('names every metric once', () => {
    const names = declared.map(([, metric]) => metric.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * Which gauges may be summed, decided here rather than on a dashboard.
   *
   * Some of these report this process's own state — requests in flight,
   * connections checked out — and `sum()` across replicas is exactly right.
   * Others are read out of Postgres at scrape time, so every replica answers
   * with the same number: the depth of a queue they all share. `sum()` over
   * one of those is wrong by the replica count, and wrong in the direction
   * that hurts — a backlog that looks ten times worse than it is, on a panel
   * nobody has reason to distrust.
   *
   * Nothing can stop somebody writing `sum()`. What this can do is force the
   * question to be answered when a gauge is added rather than when a dashboard
   * is already lying, which is what the two lists are for.
   */
  const gauges = declared.filter(
    ([, metric]) => metric.buckets === undefined && !metric.name.endsWith('_total'),
  );

  it('classifies every gauge as deployment-wide or per-process', () => {
    const classified = new Set([...DEPLOYMENT_WIDE, ...PER_PROCESS]);
    const unclassified = gauges
      .map(([, metric]) => metric.name)
      .filter((name) => !classified.has(name));

    expect(unclassified).toEqual([]);
  });

  it('classifies none of them as both, and names no metric that does not exist', () => {
    const overlap = DEPLOYMENT_WIDE.filter((name) => PER_PROCESS.includes(name));
    expect(overlap).toEqual([]);

    const known = new Set(declared.map(([, metric]) => metric.name));
    const invented = [...DEPLOYMENT_WIDE, ...PER_PROCESS].filter((name) => !known.has(name));
    expect(invented).toEqual([]);
  });

  /**
   * The instruction goes where somebody will see it: Prometheus renders `help`
   * beside the metric, which is the moment a query is being written.
   */
  it.each(DEPLOYMENT_WIDE.map((name) => [name] as const))('%s says how to aggregate it', (name) => {
    const metric = declared.find(([, candidate]) => candidate.name === name)?.[1];
    expect(metric?.help).toContain('max()');
    expect(metric?.help).toContain('never sum()');
  });
});
