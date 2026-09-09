import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ADAPTERS,
  BENCHMARK,
  TABLES,
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
    expect(file.schema).toBe(2);
    expect(Array.isArray(file.tables)).toBe(true);
    // Tables and `generatedAt` arrive together; a file with tables and no date,
    // or a date and no tables, is a half-written publish.
    expect(file.tables.length === 0).toBe(file.generatedAt === null);
  });

  /**
   * Two tabs a reader cannot tell apart is the failure the label exists to
   * prevent, and it is the one a careless publish produces: the label is a
   * pure function of the settings that make a run a different experiment, so a
   * duplicate here means two runs were published as though they were two
   * experiments when they are one.
   */
  it('gives every table a distinct name', () => {
    const labels = file.tables.map((table) => table.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });

  it('carries provenance for every number it carries', () => {
    for (const { run } of file.tables) {
      // A figure nobody can trace to a seed and a model is the thing this page
      // exists to not publish.
      expect(run.seed).toBeGreaterThanOrEqual(0);
      expect(run.model.length).toBeGreaterThan(0);
      expect(run.provider.length).toBeGreaterThan(0);
      expect(run.embedder.length).toBeGreaterThan(0);
      expect(run.repeats).toBeGreaterThan(0);
    }
  });

  it('only names categories it has questions for', () => {
    for (const table of file.tables) {
      for (const category of table.categories) {
        expect(table.run.categoryCounts[category]).toBeGreaterThan(0);
      }
    }
  });

  it('describes the corpus each table was measured over', () => {
    // A published run with no corpus block is a table whose workload nobody
    // can see, which is the misreading the section exists to prevent: this
    // benchmark is over tool-call JSON, and a reader whose data is documents
    // should be told so rather than left to assume. Every table carries its
    // own, because with `--drift` the corpus is what differs between them.
    for (const { corpus } of file.tables) {
      expect(corpus.sources.length).toBeGreaterThan(0);
      expect(corpus.records).toBe(
        corpus.sources.reduce((total, source) => total + source.records, 0),
      );
      for (const source of corpus.sources) {
        expect(source.records).toBeGreaterThan(0);
        // The sample is the load-bearing part. A source that published counts
        // and no record would leave the page asserting a shape it cannot show.
        expect(source.sample.length).toBeGreaterThan(0);
        expect(JSON.parse(source.sample)).toHaveProperty('ref');
      }
    }
  });

  it('never claims an accuracy outside 0..1', () => {
    for (const adapter of file.tables.flatMap((table) => table.adapters)) {
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

  it('describes every column the published table shows', () => {
    // The inverse of the test above, and the one that catches a column added
    // to `packages/bench`, published, and never written down. A row of numbers
    // with no account of what produced them is a number nobody can read — and
    // the page filters its blurbs to the run, so the omission is silent.
    const described = ADAPTERS.map((adapter) => adapter.name);
    for (const table of TABLES) {
      for (const adapter of table.adapters) expect(described).toContain(adapter.name);
    }
  });

  /**
   * The workload, on the page and not only in the harness.
   *
   * The failure this catches is a source added to `packages/bench` and
   * published with nothing said about it — the page filters its blurbs to the
   * run, so the omission is silent, and a card with counts and no account of
   * what the records are is the shape of thing this page exists to not ship.
   */
  it('says what kind of payloads it was asked about', () => {
    expect(markup).toContain(CORPUS_LEDE);

    const described = SOURCE_BLURBS.map((blurb) => blurb.tool);
    for (const source of TABLES[0]?.corpus.sources ?? []) {
      expect(described).toContain(source.tool);
      expect(markup).toContain(source.tool);
      // The sample is rendered verbatim, so a distinctive line of it is enough
      // to prove the record reached the page rather than only its counts. The
      // quotes come back escaped, which is React doing its job and not the
      // sample having been altered.
      const line = (source.sample.split('\n')[1] as string).trim();
      expect(markup).toContain(line.replaceAll('"', '&quot;'));
    }
  });

  it('states its limits on the page rather than in a footnote', () => {
    for (const limit of LIMITS) expect(markup).toContain(limit.title);
  });

  /**
   * The page's whole standing rests on a reader being able to go and check it,
   * so a source link that rots is worse than no link: it reads as an invitation
   * and lands on a 404.
   */
  it('links every source by the question it answers', () => {
    for (const source of SOURCES) {
      expect(markup).toContain(source.question);
      expect(markup).toContain(sourceHref(source.path));
    }
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

  /**
   * The half of the page most likely to be read by a model rather than a
   * person, and the answer it gives to "is this better than a vector store"
   * is conditional on a workload. Quoting the accuracy without the corpus is
   * the same failure as quoting it without the model.
   */
  it('carries the corpus and a record of it verbatim', () => {
    for (const source of TABLES[0]?.corpus.sources ?? []) {
      expect(body).toContain(source.tool);
      expect(body).toContain(source.sample);
    }
  });

  it('does not quote a figure without the conditions on it', () => {
    if (HAS_RESULTS && TABLES[0]) {
      expect(body).toContain(TABLES[0].run.model);
      expect(body).toContain(String(TABLES[0].run.seed));
    } else {
      expect(body).toContain('No run has been published yet');
    }
  });
});
