import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ADAPTERS,
  BENCHMARK,
  CATEGORIES,
  CORPUS_LEDE,
  HAS_RESULTS,
  LIMITS,
  SOURCE_BLURBS,
  SOURCES,
  type PublishedBenchmark,
} from '../src/benchmarks/benchmarks';
import { BenchmarksPage } from '../src/benchmarks/benchmarks-page';
import { sourceHref } from '../src/site/mode';
import { BENCHMARKS } from '../src/text/benchmarks-text';

/** The benchmarks page, whose numbers come from a published `results.json`. */

describe('the published results file', () => {
  const file = BENCHMARK as PublishedBenchmark;

  it('is the shape the page reads', () => {
    expect(file.schema).toBe(1);
    expect(Array.isArray(file.categories)).toBe(true);
    expect(Array.isArray(file.adapters)).toBe(true);
    // `run` and `generatedAt` are null together or set together.
    expect(file.run === null).toBe(file.generatedAt === null);
    if (file.adapters.length > 0) expect(file.run).not.toBeNull();
  });

  it('carries provenance for every number it carries', () => {
    if (!file.run) return;
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

  it('describes the corpus it was measured over', () => {
    expect(file.corpus === null).toBe(file.run === null);
    if (!file.corpus) return;

    expect(file.corpus.sources.length).toBeGreaterThan(0);
    expect(file.corpus.records).toBe(
      file.corpus.sources.reduce((total, source) => total + source.records, 0),
    );
    for (const source of file.corpus.sources) {
      expect(source.records).toBeGreaterThan(0);
      // A source needs a sample record, not only counts.
      expect(source.sample.length).toBeGreaterThan(0);
      expect(JSON.parse(source.sample)).toHaveProperty('ref');
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
      // The name renders upper-cased as a kicker.
      expect(markup).toContain(adapter.name.toUpperCase());
      expect(markup).toContain(adapter.blurb);
    }
    for (const category of CATEGORIES) {
      expect(markup).toContain(category.name);
      expect(markup).toContain(category.blurb);
    }
  });

  it('describes every column the published table shows', () => {
    const described = ADAPTERS.map((adapter) => adapter.name);
    for (const adapter of BENCHMARK.adapters) expect(described).toContain(adapter.name);
  });

  it('says what kind of payloads it was asked about', () => {
    expect(markup).toContain(CORPUS_LEDE);

    const described = SOURCE_BLURBS.map((blurb) => blurb.tool);
    for (const source of BENCHMARK.corpus?.sources ?? []) {
      expect(described).toContain(source.tool);
      expect(markup).toContain(source.tool);
      // Rendered verbatim; React escapes the quotes.
      const line = (source.sample.split('\n')[1] as string).trim();
      expect(markup).toContain(line.replaceAll('"', '&quot;'));
    }
  });

  it('states its limits on the page rather than in a footnote', () => {
    for (const limit of LIMITS) expect(markup).toContain(limit.title);
  });

  it('links every source by the question it answers', () => {
    for (const source of SOURCES) {
      expect(markup).toContain(source.question);
      expect(markup).toContain(sourceHref(source.path));
    }
  });

  it('says so plainly when no run has been published', () => {
    if (HAS_RESULTS) {
      expect(markup).not.toContain('No run has been published yet');
      return;
    }
    expect(markup).toContain('No run has been published yet');
    expect(markup).toContain('--publish');
    // Nothing numeric should reach the page.
    expect(markup).not.toMatch(/>\d+%</);
  });
});

describe('the markdown half', () => {
  const body = BENCHMARKS.render();

  it('says the same thing as the page', () => {
    for (const adapter of ADAPTERS) expect(body).toContain(adapter.name);
    for (const limit of LIMITS) expect(body).toContain(limit.title);
  });

  it('carries the corpus and a record of it verbatim', () => {
    for (const source of BENCHMARK.corpus?.sources ?? []) {
      expect(body).toContain(source.tool);
      expect(body).toContain(source.sample);
    }
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
