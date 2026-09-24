import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ADAPTERS,
  adapterLabel,
  BENCHMARK,
  TABLES,
  CATEGORIES,
  classesIn,
  CORPUS_LEDE,
  HAS_RESULTS,
  LIMITS,
  MATCHUP,
  SCALING,
  SOURCE_BLURBS,
  SOURCES,
  TRANSCRIPTS_FILE,
  type PublishedBenchmark,
  type PublishedTranscripts,
} from '../src/benchmarks/benchmarks';
import { BenchmarksPage } from '../src/benchmarks/benchmarks-page';
import { headline } from '../src/benchmarks/small-models';
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
    // own, because with `--logs` the corpus is what differs between them.
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

/** The `--scale` series, written whole by `packages/bench` and imported by the chart. */
describe('the published scaling file', () => {
  it('is the shape the chart reads', () => {
    expect(SCALING.schema).toBe(2);
    expect(SCALING.points.length).toBeGreaterThanOrEqual(2);
    const scales = SCALING.points.map((point) => point.scale);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
  });

  it('holds figures the chart can place', () => {
    for (const point of SCALING.points) {
      for (const adapter of point.adapters) {
        expect(adapter.accuracy).toBeGreaterThanOrEqual(0);
        expect(adapter.accuracy).toBeLessThanOrEqual(1);
        expect(adapter.contextTokens).toBeGreaterThanOrEqual(0);
        expect(adapter.overflowed).toBeLessThanOrEqual(adapter.runs);
      }
      // The drill-in's totals and its per-tool rows have to agree.
      const records = point.corpus.sources.reduce((sum, source) => sum + source.records, 0);
      expect(records).toBe(point.corpus.records);
    }
  });
});

describe('the published matchup file', () => {
  it('is the shape the small-models section reads', () => {
    expect(MATCHUP.schema).toBe(1);
    for (const cell of MATCHUP.cells) {
      expect(MATCHUP.models).toContain(cell.model);
      expect(MATCHUP.adapters).toContain(cell.adapter);
      expect(cell.correct).toBeLessThanOrEqual(cell.runs);
      expect(cell.atLimit).toBeLessThanOrEqual(cell.runs);
      expect(cell.toolCalls).toBeLessThanOrEqual(MATCHUP.run.maxToolCalls);
    }
  });
});

/**
 * The transcript sidecar, the other file `packages/bench` writes for this page.
 *
 * Fetched at runtime rather than imported, so a shape change here fails nothing
 * at build and renders an empty section in the browser instead — exactly the
 * silent failure the summary's own contract test exists to catch, one file
 * over. The load-bearing invariant is that it never carries a corpus the
 * summary does not: a transcript table whose label no summary shares is
 * unreachable, since the page joins the two files on that label.
 */
describe('the transcript sidecar on disk', () => {
  const path = join(import.meta.dir, '..', 'public', TRANSCRIPTS_FILE);
  const file = JSON.parse(readFileSync(path, 'utf8')) as PublishedTranscripts;

  it('is the shape the page fetches', () => {
    expect(file.schema).toBe(1);
    expect(Array.isArray(file.tables)).toBe(true);
    // Tables and `generatedAt` arrive together, the same as the summary: a file
    // with tables and no date, or a date and none, is a half-written publish.
    expect(file.tables.length === 0).toBe(file.generatedAt === null);
  });

  it('carries transcripts only for corpora the summary shows', () => {
    const summarised = new Set(TABLES.map((table) => table.label));
    for (const table of file.tables) {
      // A transcript table the page can never reach — no summary joins to it —
      // is an orphan a re-publish left behind, which is the failure the sidecar
      // merges per label to prevent.
      expect(summarised.has(table.label)).toBe(true);
    }
  });

  /**
   * The filter over the runs table, which is the one control that can hide a
   * transcript.
   *
   * So the invariant is coverage rather than presentation: every run belongs to
   * exactly one class the filter offers, and the counts on the buttons are the
   * rows the reader will get. The order is the page's order — `CATEGORIES`,
   * which is also the matrix's columns — for the classes it knows about; a
   * class only the sidecar carries still has to be offered, because the filter
   * is the only route to those runs.
   */
  it('offers a class for every transcript run, in the order the page teaches', () => {
    const order = CATEGORIES.map((category) => category.name);

    for (const table of file.tables) {
      const runs = table.questions.flatMap((question) =>
        question.adapters.map((run) => ({ question, run })),
      );
      const classes = classesIn(runs);

      expect(classes.reduce((total, one) => total + one.count, 0)).toBe(runs.length);
      expect(new Set(classes.map((one) => one.name)).size).toBe(classes.length);

      for (const { name, count } of classes) {
        expect(count).toBe(runs.filter(({ question }) => question.category === name).length);
      }

      const known = classes.map((one) => one.name).filter((name) => order.includes(name));
      expect(known).toEqual([...known].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
  });

  it('caps every output and keeps every input', () => {
    for (const table of file.tables) {
      for (const question of table.questions) {
        for (const adapter of question.adapters) {
          for (const call of adapter.calls) {
            expect(typeof call.input).toBe('object');
            // The output is a string and, when clipped, says so — the marker is
            // what keeps a truncation from reading as a tool that returned little.
            expect(typeof call.output).toBe('string');
            if (call.output.includes('… ') && call.output.includes(' more character')) {
              expect(call.output).toMatch(/… \d+ more characters?$/);
            }
          }
        }
      }
    }
  });
});

describe('the benchmarks page', () => {
  const markup = renderToStaticMarkup(<BenchmarksPage />);

  it('offers the transcripts once there are numbers, and nothing before', () => {
    // The control is inside the results block and lives on a click — a fetch on
    // load would be the page pulling megabytes for a section most readers never
    // open, and a control on the empty page would load data that never arrives.
    if (HAS_RESULTS) expect(markup).toContain('Show the transcripts');
    else expect(markup).not.toContain('Show the transcripts');
  });

  it('draws the scaling chart with every memory in the series', () => {
    if (!HAS_RESULTS) return;
    expect(markup).toContain('More history, same answers');
    const names = new Set(SCALING.points.flatMap((point) => point.adapters.map((a) => a.name)));
    for (const name of names) expect(markup).toContain(adapterLabel(name));
  });

  it('pits the smaller model with Ingot against the larger one, and shows every cell', () => {
    const pair = headline(MATCHUP);
    if (!pair) return;
    expect(markup).toContain('Get more out of small models');
    expect(markup).toContain(`${pair.small.correct} of ${pair.small.runs}`);
    expect(markup).toContain(`${pair.large.correct} of ${pair.large.runs}`);
    for (const model of MATCHUP.models) expect(markup).toContain(model);
  });

  it('opens the largest memory in the drill-in, with every tool that went into it', () => {
    if (!HAS_RESULTS) return;
    const last = SCALING.points[SCALING.points.length - 1];
    if (!last) return;
    expect(markup).toContain(`Corpus at ${last.scale}×`);
    for (const source of last.corpus.sources) expect(markup).toContain(source.tool);
  });

  it('says how accuracy is scored inside the run', () => {
    if (!HAS_RESULTS) return;
    expect(markup).toContain('Exactly right, or wrong');
    expect(markup).toContain('No partial credit');
  });

  it('explains every adapter and every category', () => {
    for (const adapter of ADAPTERS) {
      // The label is set as a kicker, which upper-cases it in the markup; the
      // blurb is what actually has to be on the page. The label rather than the
      // name, because the run's name for a column is not what the page calls it.
      expect(markup).toContain(adapterLabel(adapter.name).toUpperCase());
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

  it('offers every published corpus by name', () => {
    // The switch is the only route to a table that is not the first, so a
    // corpus published into `results.json` and missing from here is a run
    // bought and then hidden.
    if (TABLES.length > 1) for (const table of TABLES) expect(markup).toContain(table.label);
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
    for (const adapter of ADAPTERS) expect(body).toContain(adapterLabel(adapter.name));
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
