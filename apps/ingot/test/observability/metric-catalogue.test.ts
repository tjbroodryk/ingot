import { describe, expect, it } from 'bun:test';
import {
  DEPLOYMENT_WIDE,
  Metrics,
  PER_PROCESS,
} from '../../src/observability/metrics/catalogue.js';
import { METRIC_PREFIX } from '../../src/observability/metrics/registry.js';

/** Naming and cardinality rules over the one file that declares every metric. */
interface Declared {
  name: string;
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
}

/** The spec lives on `.declaration` rather than on the instrument. */
const declared = Object.entries(Metrics).map(
  ([key, metric]) => [key, (metric as { declaration: Declared }).declaration] as const,
);

// Histograms whose unit is not seconds, listed so adding one is a visible edit.
const NOT_SECONDS: Readonly<Record<string, string>> = {
  ingot_query_rows_returned: 'Counts rows in a result, which have no unit suffix.',
};

describe('the metric catalogue', () => {
  it('declares some metrics', () => {
    expect(declared.length).toBeGreaterThan(5);
  });

  it.each(declared)('%s is namespaced to this service', (_key, metric) => {
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

  // No tenant identity on a label: it would be one series per tenant. Per-tenant
  // detail goes on the span instead.
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

  // Gauges split into those reporting per-process state (summable) and those
  // read from shared Postgres at scrape time (not summable).
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

  // The aggregation instruction lives in `help`, beside the metric.
  it.each(DEPLOYMENT_WIDE.map((name) => [name] as const))('%s says how to aggregate it', (name) => {
    const metric = declared.find(([, candidate]) => candidate.name === name)?.[1];
    expect(metric?.help).toContain('max()');
    expect(metric?.help).toContain('never sum()');
  });
});
