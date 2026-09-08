import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ADAPTERS,
  BENCHMARK,
  CATEGORIES,
  HAS_RESULTS,
  LIMITS,
  type PublishedBenchmark,
} from '../src/benchmarks/benchmarks';
import { BenchmarksPage } from '../src/benchmarks/benchmarks-page';
import { BENCHMARKS } from '../src/text/benchmarks-text';

/**
 * The benchmarks page, which is the only page on this site whose content comes
 * from a file another workspace writes.
 *
 * That is the thing worth holding up. Every other page's copy is a constant in
 * the module beside it, and a typo is a typo; this one renders numbers that
 * `packages/bench` produced, so the failure mode is a shape change in
 * `results.json` that silently renders an empty table on a published page. So
 * the assertions are about the contract — the file still parses to what the
 * page expects — and about the empty state, which is what visitors see until a
 * run has been published and is therefore the state most likely to ship.
 */

describe('the published results file', () => {
  const file = BENCHMARK as PublishedBenchmark;

  it('is the shape the page reads', () => {
    expect(file.schema).toBe(1);
    expect(Array.isArray(file.categories)).toBe(true);
    expect(Array.isArray(file.adapters)).toBe(true);
    // `run` and `generatedAt` are null together or set together; a file with a
    // run and no date, or adapters and no run, is a half-written publish.
    expect(file.run === null).toBe(file.generatedAt === null);
    if (file.adapters.length > 0) expect(file.run).not.toBeNull();
  });

  it('carries provenance for every number it carries', () => {
    if (!file.run) return;
    // A figure nobody can trace to a seed and a model is the thing this page
    // exists to not publish.
    expect(file.run.seed).toBeGreaterThanOrEqual(0);
    expect(file.run.model.length).toBeGreaterThan(0);
    expect(file.run.provider.length).toBeGreaterThan(0);
    expect(file.run.embedder.length).toBeGreaterThan(0);
    expect(file.run.repeats).toBeGreaterThan(0);
  });

  it('only names categories it has questions for', () => {
    if (!file.run) return;
    for (const category of file.categories) {
      expect(file.run.categoryCounts[category]).toBeGreaterThan(0);
    }
  });

  it('never claims an accuracy outside 0..1', () => {
    for (const adapter of file.adapters) {
      expect(adapter.accuracy).toBeGreaterThanOrEqual(0);
      expect(adapter.accuracy).toBeLessThanOrEqual(1);
      for (const value of Object.values(adapter.byCategory)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the benchmarks page', () => {
  const markup = renderToStaticMarkup(<BenchmarksPage />);

  it('explains every adapter and every category', () => {
    for (const adapter of ADAPTERS) {
      // The name is set as a kicker, which upper-cases it in the markup; the
      // blurb is what actually has to be on the page.
      expect(markup).toContain(adapter.name.toUpperCase());
      expect(markup).toContain(adapter.blurb);
    }
    for (const category of CATEGORIES) {
      expect(markup).toContain(category.name);
      expect(markup).toContain(category.blurb);
    }
  });

  it('states its limits on the page rather than in a footnote', () => {
    for (const limit of LIMITS) expect(markup).toContain(limit.title);
  });

  /**
   * The assertion that matters most. A page about measurement that shipped
   * invented figures would undo the only thing it is for, so the empty state
   * has to say it is empty rather than render a table of zeroes.
   */
  it('says so plainly when no run has been published', () => {
    if (HAS_RESULTS) {
      expect(markup).not.toContain('No run has been published yet');
      return;
    }
    expect(markup).toContain('No run has been published yet');
    expect(markup).toContain('--publish');
    // No percentages anywhere: nothing numeric should reach the page.
    expect(markup).not.toMatch(/>\d+%</);
  });
});

describe('the markdown half', () => {
  const body = BENCHMARKS.render();

  it('says the same thing as the page', () => {
    for (const adapter of ADAPTERS) expect(body).toContain(adapter.name);
    for (const limit of LIMITS) expect(body).toContain(limit.title);
  });

  it('does not quote a figure without the conditions on it', () => {
    if (HAS_RESULTS && BENCHMARK.run) {
      expect(body).toContain(BENCHMARK.run.model);
      expect(body).toContain(String(BENCHMARK.run.seed));
    } else {
      expect(body).toContain('No run has been published yet');
    }
  });
});
