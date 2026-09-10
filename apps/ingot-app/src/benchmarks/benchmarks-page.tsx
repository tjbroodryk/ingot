'use client';

// The directive is the first statement in the file and has to stay there: a
// comment above it is tolerated by TypeScript and not by the bundler, which
// silently builds this as a server component and fails at prerender with an
// undefined export rather than anything that names the cause.
//
// The page is a client component for one reason: the switch between published
// corpora is state, and both the results section and the corpus section below
// it have to move together — the drifted run's payload samples are the drifted
// payloads. Splitting the state out would mean two components that have to
// agree about which run is showing, which is the bug this avoids.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { BASE_PATH, DOCS_HREF, REPO_URL, sourceHref, WHY_HREF } from '../site/mode';
// The landing page's layout, used rather than restated, the way `/why` uses
// it: this page is the same shape of document — a hero and ruled bands.
import '../landing/landing.css';
import './benchmarks.css';
import { Prose } from '../docs/prose';
import {
  ADAPTERS,
  arrival,
  BENCHMARK,
  BENCHMARKS_LEDE,
  CATEGORIES,
  CONTROL_NAMES,
  CORPUS_JOINS,
  CORPUS_LEDE,
  countWord,
  HAS_RESULTS,
  leadStats,
  TABLES,
  mappingWriter,
  LIMITS,
  SOURCE_BLURBS,
  SOURCES,
  TRANSCRIPTS_FILE,
  type AdapterTranscript,
  type PublishedAdapter,
  type PublishedTable,
  type PublishedTranscripts,
  type TranscriptQuestion,
} from './benchmarks';

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * What an agent gets back out, measured.
 *
 * Everything numeric on this page comes from `results.json`, which
 * `packages/bench` writes from a real run. There is no path by which a figure
 * here can be typed by hand, which is the only reason a page like this is
 * worth publishing at all — a benchmark whose numbers cannot be traced to a
 * seed, a model and a date is an advertisement.
 *
 * Until a run has been published the page says so and shows the method
 * instead. That is deliberate: an empty state is honest, and placeholder
 * numbers on a page about measurement would be the worst thing this site could
 * ship.
 */
export function BenchmarksPage(): ReactNode {
  /*
   * Which published run the page is showing.
   *
   * State rather than a route because the tables are the same questions and
   * the same columns over two corpora, and a reader comparing them wants to
   * flick between them with the scroll position kept. A URL per corpus would
   * also make the drifted numbers linkable on their own, which is the one
   * reading of them that is not true — they mean nothing except beside the
   * ordinary ones.
   */
  const [selected, setSelected] = useState(0);
  const table = TABLES[selected] ?? TABLES[0] ?? null;
  const { run, categories, adapters } = table ?? {
    run: null,
    categories: [] as readonly string[],
    adapters: [] as readonly PublishedAdapter[],
  };

  return (
    <>
      <SiteHeader
        current={SiteSection.Benchmarks}
        actions={
          <a className="btn-solid" href={REPO_URL}>
            Get the source
          </a>
        }
      />

      <div className="landframe">
        <section className="hero">
          <div className="hero-badge label">
            <span className="badge">The measurement</span>
            {/*
              The workload is linked from the hero because it is the first
              thing that decides whether the table below applies to anybody's
              own problem. A reader whose corpus is prose documents should find
              out that this one is tool-call JSON before they read a number,
              not three sections after it.
            */}
            <a href="#corpus">What it is asked about</a>
            <a href="#method">How this is scored</a>
          </div>

          <h1 className="hero-title">
            What comes
            <br />
            back <span className="mark">out</span>
          </h1>

          <p className="hero-lede">{BENCHMARKS_LEDE}</p>

          <div className="hero-actions label">
            <a className="btn-solid btn-lg" href="#results">
              {HAS_RESULTS ? 'See the numbers' : 'See the method'}
            </a>
            {WHY_HREF ? (
              <a className="btn-outline btn-lg" href={WHY_HREF}>
                Read the argument
              </a>
            ) : null}
          </div>
        </section>

        <section className="landblock" id="results">
          <div className="landhead">
            <span className="label label-sm kicker">[ Results ]</span>
            <h2 className="landtitle">
              Accuracy,
              <br />
              <span className="mark">per category</span>
            </h2>
            <p>
              The split by category is the whole point of the benchmark. The claim under test is
              that SQL over typed rows, on top of ranking by meaning, recalls more of the answer
              than similarity search alone. Each category is somewhere that claim can fail.
              Aggregates, absence, ordering and joins are where structure should tell; the semantic
              questions are where embeddings should. Report one number and you have averaged all of
              that away.
            </p>
          </div>

          {/*
            The switch is above the numbers rather than beside them, because
            which corpus a table was measured over is not a filter on the
            table — it is what the table is. A reader who scrolls past it and
            reads the drifted numbers as the headline result has been misled by
            the layout, so it sits where the heading would.
          */}
          {TABLES.length > 1 ? (
            <div className="bench-switch label label-sm">
              <span className="bench-switch-legend">measured over</span>
              {TABLES.map((option, index) => (
                <button
                  aria-pressed={index === selected}
                  className="bench-switch-option"
                  key={option.label}
                  onClick={() => setSelected(index)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}

          {run ? (
            <>
              <Tiles table={table} />
              <RankedAccuracy adapters={adapters} />
              <HeatMatrix categories={categories} adapters={adapters} />
              <Provenance table={table} />
              <CostTable adapters={adapters} />
              <Failures adapters={adapters} />
              <p className="bench-note">
                Evidence recall is the share of the answer-bearing records that came back through
                the tools; precision is the share of what came back that was answer-bearing. Both
                are computed only over questions whose answer is a set of records — see the limits
                below. Context tokens is what the model had to read to answer.
              </p>
              <Transcripts table={table} />
            </>
          ) : (
            <div className="bench-empty">
              <h3>No run has been published yet.</h3>
              <p>
                The harness is in <code>packages/bench</code> and the method below is what it does.
                This page fills in when a run is published into it:
              </p>
              <pre className="bench-pre">
                <code>
                  bun run bench --publish ../../apps/ingot-app/src/benchmarks/results.json
                </code>
              </pre>
            </div>
          )}
        </section>

        <section className="landblock" id="corpus">
          <div className="landhead">
            <span className="label label-sm kicker">[ What it is asked about ]</span>
            <h2 className="landtitle">
              Tool results,
              <br />
              <span className="mark">not documents</span>
            </h2>
            <p>{CORPUS_LEDE}</p>
          </div>

          <CorpusShape table={table} />
        </section>

        <section className="landblock" id="method">
          <div className="landhead">
            <span className="label label-sm kicker">[ What is compared ]</span>
            {/*
              "Columns" rather than "memories", because two of them are not
              memories: `raw-context` answers from the prompt and is a
              reference point. The heading counting the columns and the section
              listing that many cells is the agreement that matters.
            */}
            <h2 className="landtitle">
              {countWord(ADAPTERS.length)} columns,
              <br />
              <span className="mark">one agent</span>
            </h2>
            <p>
              One agent loop serves every column, with the same model, the same tool-call budget and
              the same answer channel. Only the retrieval tools differ, so a gap between two columns
              has exactly one possible cause.
            </p>
          </div>

          <div className="steps">
            {ADAPTERS.map((adapter) => (
              <div className="step" key={adapter.name}>
                <div className="step-num">{adapter.name.toUpperCase()}</div>
                <p>{adapter.blurb}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="landblock" id="limits">
          <div className="landhead">
            <span className="label label-sm kicker">[ What this does not measure ]</span>
            <h2 className="landtitle">
              The limits,
              <br />
              <span className="mark">on the page</span>
            </h2>
            <p>
              We are publishing a benchmark of our own software, which you should discount
              accordingly. The least we can do is say plainly where it is weak, so here is
              everything we know is wrong with it — worth reading before you trust anything above.
            </p>
          </div>

          <div className="steps">
            {LIMITS.map((limit) => (
              <div className="step" key={limit.title}>
                {/*
                  `.step-num` rather than a heading, so these read as the
                  method section's cells do. That class sets the treatment —
                  mono, letterspaced, accent — and not the casing, which is
                  why the adapter names are upper-cased at their call site and
                  a sentence like this one is not.
                */}
                <div className="step-num">{limit.title}</div>
                <p>{limit.body}</p>
              </div>
            ))}
          </div>

        </section>

        <section className="landblock" id="check">
          <div className="landhead">
            <span className="label label-sm kicker">[ Check it ]</span>
            <h2 className="landtitle">
              Every claim,
              <br />
              <span className="mark">one file away</span>
            </h2>
            <p>
              This is worth exactly as much as your ability to go and check it, so every part of it
              is one file, linked below by the question it answers. If you want to know whether we
              shaped the questions to flatter ourselves, read the generator — do not take our word
              for it.
            </p>
          </div>

          <div className="steps">
            {SOURCES.map((source) => (
              <div className="step" key={source.path}>
                <div className="step-num">
                  <a href={sourceHref(source.path)}>{source.question}</a>
                </div>
                <p>{source.detail}</p>
                <code>{source.path}</code>
              </div>
            ))}
          </div>

          <div className="bench-strip">
            <p>
              Or run it yourself against a seed of your own — <code>--dry-run</code> prints every
              question and every gold answer without spending anything.
            </p>
            <div className="hero-actions label">
              <a className="btn-solid" href={sourceHref('packages/bench/README.md')}>
                The methodology
              </a>
              <a className="btn-outline" href={DOCS_HREF}>
                View docs
              </a>
            </div>
          </div>
        </section>
      </div>

      <SiteFooter />
    </>
  );
}

/** What produced the numbers, beside the numbers. */
function Provenance({ table }: { table: PublishedTable | null }): ReactNode {
  const run = table?.run;
  if (!run) return null;

  const facts: readonly [string, string][] = [
    ['seed', String(run.seed)],
    ['agent', `${run.model} on ${run.provider}`],
    ['reasoning', run.thinking ? run.effort : 'off'],
    ['embedder', run.embedder],
    ['runs per question', String(run.repeats)],
    ['tool-call budget', String(run.maxToolCalls)],
    ['ingot column mapping', mappingWriter(run.mapping)],
    ['questions', String(run.questions)],
    // Kept when the run stamp went, because how old a benchmark is changes
    // what it is worth — a table with no date is a table nobody can age.
    ...(BENCHMARK.generatedAt
      ? ([['published', BENCHMARK.generatedAt.slice(0, 10)]] as [string, string][])
      : []),
  ];

  return (
    <div className="bench-prov">
      <dl>
        {facts.map(([term, value]) => (
          <div key={term}>
            <dt className="label label-sm">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The workload, shown rather than characterised.
 *
 * Every figure and every sample here comes out of `results.json` the same way
 * the accuracies do — `packages/bench` rebuilds the corpus from the run's seed
 * at publish time, so what a card shows is the payload that adapter actually
 * ingested, down to the bytes. A hand-written "roughly five hundred records of
 * engineering data" would be a description of the fixture; this is the fixture.
 *
 * The sample matters more than the counts. "Tool results" is an abstraction a
 * reader has to take on trust, and one record of real JSON with a nested array
 * of file paths in it settles what kind of thing is being remembered in less
 * time than a paragraph does.
 */
function CorpusShape({ table }: { table: PublishedTable | null }): ReactNode {
  const corpus = table?.corpus ?? null;
  const run = table?.run ?? null;
  const count = (value: number): string => value.toLocaleString('en-GB');

  // Described by the catalogue, in the order the agent met them. With no
  // published run there are no numbers to attach, and the section falls back
  // to saying what the harness will collect — the same rule the adapter
  // blurbs follow.
  const entries = corpus
    ? corpus.sources.map((source) => ({
        source,
        blurb: SOURCE_BLURBS.find((entry) => entry.tool === source.tool),
      }))
    : SOURCE_BLURBS.map((blurb) => ({ source: null, blurb }));

  // What the whole thing weighs in the window, measured rather than estimated:
  // `raw-context` puts the corpus in the prompt, so its input-token count is
  // the corpus in tokens plus a question. A characters-to-tokens ratio would
  // be this page guessing at the one number it can simply read.
  const rawContext = table?.adapters.find((adapter) => adapter.name === 'raw-context');

  return (
    <>
      {corpus ? (
        <div className="bench-facts">
          <dl>
            <div>
              <dt className="label label-sm">payloads</dt>
              <dd>{count(corpus.results)}</dd>
            </div>
            <div>
              <dt className="label label-sm">records</dt>
              <dd>{count(corpus.records)}</dd>
            </div>
            <div>
              <dt className="label label-sm">characters of JSON</dt>
              <dd>{count(corpus.bytes)}</dd>
            </div>
            {rawContext ? (
              <div>
                <dt className="label label-sm">tokens, in raw-context’s prompt</dt>
                <dd>{count(rawContext.contextTokens)}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}

      {/*
        Between the totals and the samples, because it is the fact that makes
        the samples mean something: six payloads that describe themselves and
        nothing else, joined only by values that happen to match.
      */}
      <div className="bench-joins">
        <div className="bench-rule label label-sm">
          <span>What joins them</span>
          <span className="bench-rule-line" aria-hidden="true" />
          <span>No schema, no keys</span>
        </div>
        <dl>
          {CORPUS_JOINS.map((join) => (
            <div key={`${join.from}-${join.to}`}>
              <dt>
                <code>{join.from}</code>
                <span aria-hidden="true"> → </span>
                <code>{join.to}</code>
              </dt>
              <dd>
                <Prose text={join.by} />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="bench-sources">
        {entries.map(({ source, blurb }) => {
          const tool = source?.tool ?? blurb?.tool ?? '';
          return (
            <div className="bench-source" key={tool}>
              <div className="bench-source-head">
                <code className="bench-source-tool">{tool}</code>
                {blurb ? <span className="label label-sm bench-source-shape">{blurb.shape}</span> : null}
              </div>

              {source ? <p className="bench-source-stat">{arrival(source)}</p> : null}

              {blurb ? (
                <p>
                  <Prose text={blurb.blurb} />
                </p>
              ) : null}

              {source?.sample ? (
                <pre className="bench-sample">
                  <code>{source.sample}</code>
                </pre>
              ) : null}
            </div>
          );
        })}
      </div>

      {run && run.logs === 0 ? (
        <p className="bench-note">
          <Prose
            text={
              'This run is the ordinary corpus — `--logs 0` — so every payload above is a ' +
              'paginated listing that fits in a window. The other shape does not: one ' +
              '`logs.search` that comes back with tens of thousands of lines in a single ' +
              'result. It is a different experiment rather than a bigger one — `raw-context` ' +
              'is refused before inference rather than scored, and top-k finds a shrinking ' +
              'share of what an aggregate needs while a count over rows does not care how ' +
              'many there are — and no such run is published here yet.'
            }
          />
        </p>
      ) : null}

      {/*
       * The corpus above is one shape per tool, and that is the assumption most
       * worth naming out loud: it is the case this project is most flattered
       * by, because a corpus that never changes shape is a table already. The
       * note says so on the ordinary run rather than only on the drifted one —
       * a caveat that appears only when the numbers are bad is an excuse.
       */}
      {run ? (
        <p className="bench-note">
          <Prose
            text={
              run.drift
                ? 'This run was bought with `--drift`: partway through each listing a field ' +
                  'is renamed, a unit changes with the name, a string becomes an object and a ' +
                  'foreign key arrives late. Every ' +
                  'record is still present exactly once, so every question above is still ' +
                  'answerable — but not by anything that fixed its schema on the first page, ' +
                  'which is the cost Ingot pays and a vector index does not. These numbers ' +
                  'are not comparable with a run over the ordinary corpus.'
                : 'Every payload above also keeps one shape from first page to last, which is ' +
                  'the friendliest assumption on this page: real tools rename fields, change ' +
                  'units, return an object where a string used to be, and hand back a ' +
                  'return an object where a string used to be. `--drift` is the run ' +
                  'that does all of that, and it is the one where committing to a column ' +
                  'mapping before the last page has a price — so it costs Ingot more than it ' +
                  'costs a vector index. No such run is published here yet.'
            }
          />
        </p>
      ) : null}
    </>
  );
}

/** A number as a share of the row, for the bar behind it. */
function bar(value: number): Record<string, string> {
  return { ['--v' as string]: String(Math.round(value * 100)) };
}

/** The three figures that lead the section, computed in `benchmarks.ts`. */
function Tiles({ table }: { table: PublishedTable | null }): ReactNode {
  const stats = leadStats(table);
  if (stats.length === 0) return null;
  return (
    <div className="bench-tiles">
      {stats.map((stat) => (
        <div className="bench-tile" key={stat.label}>
          <div className="bench-tile-value">{stat.value}</div>
          <div className="bench-tile-label label label-sm">
            {stat.label} —{' '}
            {stat.subjects.map((subject, index) => (
              <span key={subject}>
                {index > 0 ? ' to ' : ''}
                <span className="mark bench-tile-mark">{subject}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Overall accuracy as a ranked bar list.
 *
 * A bar you can compare by length beats a column of percentages you have to
 * compare by reading, and ranking makes the order the reading order. The
 * control keeps its own group: `raw-context` placed fourth in a race it was
 * not running is the wrong reading, and a flush list invites exactly that.
 */
function RankedAccuracy({ adapters }: { adapters: readonly PublishedAdapter[] }): ReactNode {
  const byScore = (a: PublishedAdapter, b: PublishedAdapter): number => b.accuracy - a.accuracy;
  const memories = adapters.filter((a) => !CONTROL_NAMES.has(a.name)).sort(byScore);
  const controls = adapters.filter((a) => CONTROL_NAMES.has(a.name)).sort(byScore);

  // Context bars are scaled against the heaviest adapter in the run, controls
  // included: the point of putting the two side by side is that `raw-context`
  // reading the whole corpus is the thing the retrieval columns are cheaper
  // than, and a scale that excluded it would hide that.
  const peak = Math.max(...adapters.map((adapter) => adapter.contextTokens), 1);

  const row = (adapter: PublishedAdapter, muted: boolean): ReactNode => (
    <li className={muted ? 'bench-rank bench-rank-muted' : 'bench-rank'} key={adapter.name}>
      <code className="bench-rank-name">{adapter.name}</code>
      <span className="bench-rank-track">
        <span className="bench-rank-fill" style={bar(adapter.accuracy)} aria-hidden="true" />
      </span>
      <span className="bench-rank-value">
        <strong>{percent(adapter.accuracy)}</strong>{' '}
        <span className="muted">±{percent(adapter.stderr)}</span>
      </span>
      <span className="bench-rank-track bench-rank-track-cost">
        <span
          className="bench-rank-fill bench-rank-fill-cost"
          style={bar(adapter.contextTokens / peak)}
          aria-hidden="true"
        />
      </span>
      <span className="bench-rank-value bench-rank-cost">
        {adapter.contextTokens.toLocaleString('en-GB')}
      </span>
    </li>
  );

  return (
    <div className="bench-ranked">
      {/*
        Accuracy and cost on one row, because the interesting reading of this
        benchmark is the pair. An adapter that answers well by pulling eighty
        thousand tokens through the model has not solved the problem the same
        way as one that answers well on four thousand, and two separate tables
        make a reader hold one in their head while looking at the other.
      */}
      <div className="bench-rank bench-rank-head label label-sm">
        <span>Overall accuracy</span>
        <span />
        <span />
        <span />
        <span className="bench-rank-cost">Context tokens</span>
      </div>
      <ol className="bench-ranks">{memories.map((adapter) => row(adapter, false))}</ol>
      {controls.length > 0 ? (
        <>
          <h3 className="bench-subhead label label-sm bench-subhead-quiet">
            Reference points — not competitors
          </h3>
          <ol className="bench-ranks">{controls.map((adapter) => row(adapter, true))}</ol>
        </>
      ) : null}
    </div>
  );
}

/**
 * A column header that carries its own definition.
 *
 * The categories are what the matrix means — "absence 0%" says nothing until
 * you know absence is the class whose answer is defined by what is missing —
 * and that belongs next to the number rather than in a section further down
 * the page, which a reader has already scrolled past by the time they need it.
 *
 * CSS-only, because this site is a static export and a tooltip is not worth
 * shipping a runtime for. `tabIndex` and `aria-describedby` are what keep it
 * reachable without a mouse: the icon takes focus, and the description is
 * announced rather than merely drawn.
 */
function CategoryHead({ category, end }: { category: string; end: boolean }): ReactNode {
  const blurb = CATEGORIES.find((entry) => entry.name === category)?.blurb;
  if (!blurb) return <>{category}</>;

  const id = `bench-tip-${category}`;
  return (
    <span className="bench-th">
      {category}
      {/*
        A button rather than a span with `tabindex`: this is a focusable
        affordance, and the element that already means that gets keyboard
        behaviour and the right role without being told.
      */}
      <button type="button" className="bench-info" aria-describedby={id}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="7.1" y="6.6" width="1.8" height="5" fill="currentColor" />
          <rect x="7.1" y="3.8" width="1.8" height="1.8" fill="currentColor" />
        </svg>
        <span className="bench-sr">what {category} means</span>
        <span className={end ? 'bench-tip bench-tip-end' : 'bench-tip'} role="tooltip" id={id}>
          {blurb}
        </span>
      </button>
    </span>
  );
}

/**
 * Per-category accuracy as a heat matrix.
 *
 * A real table, because it is tabular data and a screen reader should get row
 * and column headers — but spaced and filled so the eye reads it as a grid of
 * blocks rather than a wall of numerals. The number is centred and set large
 * because at this size the *fill* is the first read and the digits are the
 * confirmation.
 *
 * Intensity is one hue getting darker, never a red-to-green ramp: it encodes
 * the value, which is a fact, where a good/bad palette would encode a verdict
 * these error bars cannot support. Zero is drawn as an outline rather than the
 * palest fill, so "none of them" cannot be mistaken for "a few", and `—` — a
 * question never asked — stays visually distinct from both.
 */
function HeatMatrix({
  categories,
  adapters,
}: {
  categories: readonly string[];
  adapters: readonly PublishedAdapter[];
}): ReactNode {
  const byScore = (a: PublishedAdapter, b: PublishedAdapter): number => b.accuracy - a.accuracy;
  const memories = adapters.filter((a) => !CONTROL_NAMES.has(a.name)).sort(byScore);
  const controls = adapters.filter((a) => CONTROL_NAMES.has(a.name)).sort(byScore);

  const cells = (adapter: PublishedAdapter, control: boolean): ReactNode =>
    categories.map((category) => {
      const value = adapter.byCategory[category];
      if (value === undefined) {
        return (
          <td key={category} className="bench-heat bench-heat-na" aria-label="not applicable">
            —
          </td>
        );
      }
      if (control) {
        return (
          <td key={category} className="bench-heat bench-heat-ctl">
            {Math.round(value * 100)}
          </td>
        );
      }
      // The flip point is where the fill stops being light enough to carry
      // dark text. Below it the cell is pale and the ink stays dark.
      const dark = value >= 0.55;
      return (
        <td
          key={category}
          className={`bench-heat${value === 0 ? ' bench-heat-zero' : ''}${dark ? ' bench-heat-deep' : ''}`}
          style={bar(value)}
        >
          {Math.round(value * 100)}
        </td>
      );
    });

  return (
    <div className="bench-scroll">
      <div className="bench-rule label label-sm">
        <span>Accuracy by task class</span>
        <span className="bench-rule-line" aria-hidden="true" />
        <span>Darker = higher</span>
      </div>

      <table className="bench-matrix">
        <thead>
          <tr>
            <th scope="col">
              <span className="bench-sr">adapter</span>
            </th>
            {categories.map((category, index) => (
              <th scope="col" key={category}>
                <CategoryHead
                  category={category}
                  // The last two open leftward. The scroll container clips at
                  // its own edge, and a tooltip centred on the final column
                  // would open into that clip.
                  end={index >= categories.length - 2}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {memories.map((adapter, index) => (
            <tr key={adapter.name}>
              <th scope="row" className={index < 2 ? 'bench-lead' : ''}>
                {adapter.name}
              </th>
              {cells(adapter, false)}
            </tr>
          ))}
        </tbody>
        {controls.length > 0 ? (
          <tbody className="bench-matrix-ctl">
            {/*
              A spacer row rather than a border on the tbody: under
              `border-collapse: separate` only cells paint borders, so a rule
              on the group would simply not appear.
            */}
            <tr className="bench-matrix-gap">
              <td colSpan={categories.length + 1} />
            </tr>
            {controls.map((adapter) => (
              <tr key={adapter.name}>
                <th scope="row">{adapter.name}</th>
                {cells(adapter, true)}
              </tr>
            ))}
          </tbody>
        ) : null}
      </table>
    </div>
  );
}

/**
 * Runs that never happened, named beside the numbers they dragged down.
 *
 * A provider throwing is scored as a wrong answer — a memory that could not be
 * asked did not answer — and that is the right call for the accuracy column.
 * It is the wrong thing to leave unsaid, because "this adapter did badly" and
 * "a fifth of this adapter's runs died on a rate limit" are different readings
 * of the same figure, and only the first one is about retrieval.
 *
 * Rendered as a warning rather than a table column: it is almost always zero
 * for every row, and a column of noughts would earn its width about once a
 * year while making the table harder to read the rest of the time.
 */
function Failures({ adapters }: { adapters: readonly PublishedAdapter[] }): ReactNode {
  const hit = adapters.filter((adapter) => adapter.failures > 0);
  if (hit.length === 0) return null;

  const total = hit.reduce((sum, adapter) => sum + adapter.failures, 0);
  const runs = adapters.reduce((sum, adapter) => sum + adapter.runs, 0);

  return (
    <div className="bench-prov">
      <p className="bench-warning">
        {`${total} of ${runs} agent runs failed outright — the provider threw and nothing was answered: `}
        {hit.map((adapter, index) => (
          <span key={adapter.name}>
            {index > 0 ? ', ' : ''}
            <code>{adapter.name}</code> {adapter.failures} of {adapter.runs}
          </span>
        ))}
        {'. They are scored wrong, because a memory that could not be asked did not answer — but ' +
          'they are infrastructure failures rather than retrieval failures, and a column carrying ' +
          'several of them is reading lower than what it did with the questions it got.'}
      </p>
    </div>
  );
}

function CostTable({ adapters }: { adapters: readonly PublishedAdapter[] }): ReactNode {
  return (
    <div className="bench-scroll">
      <table className="bench-table">
        <thead>
          <tr>
            <th scope="col">adapter</th>
            <th scope="col">set F1</th>
            <th scope="col">evidence recall</th>
            <th scope="col">evidence precision</th>
            <th scope="col">tool calls</th>
            <th scope="col">context tokens</th>
          </tr>
        </thead>
        <tbody>
          {adapters.map((adapter) => (
            <tr key={adapter.name}>
              <th scope="row">
                <code>{adapter.name}</code>
              </th>
              <td>{adapter.f1.toFixed(2)}</td>
              <td>{adapter.evidenceRecall === null ? '—' : percent(adapter.evidenceRecall)}</td>
              <td>
                {adapter.evidencePrecision === null ? '—' : percent(adapter.evidencePrecision)}
              </td>
              <td>{adapter.toolCalls.toFixed(1)}</td>
              <td>{adapter.contextTokens.toLocaleString('en-GB')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One run — one column's attempt at one question — as the table lists it. */
interface Run {
  readonly question: TranscriptQuestion;
  readonly run: AdapterTranscript;
}

/**
 * What each column actually did, one run at a time.
 *
 * The section the whole change exists for. Every number above is a mean over
 * transcripts, and a mean asks to be trusted where a transcript can be checked:
 * one screen showing the same store answered two ways, one of them silently
 * wrong, is worth more than a percentage. The table lists the runs; a trace
 * opens the one a reader wants to check — the SQL it wrote or the searches it
 * ran, the rows that came back, and the answer it gave against the gold.
 *
 * The transcripts are not imported — they are tens of megabytes and would sit
 * in the bundle for a section most readers never open — so they are fetched,
 * and only when a reader asks. Nothing is fetched on load; the button below is
 * the fetch. With no published run there is no table and this renders nothing:
 * the empty state is method-only, and a control that loads data that will never
 * arrive is worse than no control.
 */
function Transcripts({ table }: { table: PublishedTable | null }): ReactNode {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [data, setData] = useState<PublishedTranscripts | null>(null);
  const [trace, setTrace] = useState<Run | null>(null);

  // No run, no transcripts: degrade to nothing rather than to a dead control.
  if (!table) return null;

  const load = async (): Promise<void> => {
    if (state === 'loading' || state === 'ready') return;
    setState('loading');
    try {
      // Through BASE_PATH, so the fetch resolves when the site is served from a
      // subdirectory (GitHub Pages puts a project site under `/<repo>/`). A
      // root-relative path would 404 there and nowhere a developer would see it.
      const response = await fetch(`${BASE_PATH}/${TRANSCRIPTS_FILE}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(String(response.status));
      setData((await response.json()) as PublishedTranscripts);
      setState('ready');
    } catch {
      setState('error');
    }
  };

  // The sidecar carries every corpus; which one the reader is looking at is the
  // selected table's label. A run published before transcripts existed, or one
  // whose sidecar entry has not caught up, simply has no match — said plainly
  // rather than spun.
  const forThis = data?.tables.find((one) => one.label === table.label) ?? null;

  // One row per (question, adapter), grouped by question the way the sidecar
  // already orders them — the order the summary shows the columns in.
  const runs: readonly Run[] =
    forThis?.questions.flatMap((question) =>
      question.adapters.map((run) => ({ question, run })),
    ) ?? [];

  return (
    <div className="bench-transcripts">
      <div className="bench-rule label label-sm">
        <span>What each column did</span>
        <span className="bench-rule-line" aria-hidden="true" />
        <span>Open a trace</span>
      </div>

      {state === 'idle' ? (
        <div className="bench-transcripts-prompt">
          <p>
            Every number above is a mean over transcripts, and a transcript can be checked where a
            mean has to be trusted. Load them to see what each column actually did to answer a
            question — the SQL it wrote or the searches it ran, the rows that came back, and the
            answer it gave.
          </p>
          <button className="btn-outline" type="button" onClick={() => void load()}>
            Show the transcripts
          </button>
        </div>
      ) : null}

      {state === 'loading' ? <p className="bench-note">Loading the transcripts…</p> : null}

      {state === 'error' ? (
        <p className="bench-note">
          The transcripts could not be loaded. They are a separate file published beside the
          numbers, and a run from before transcript publishing has none to show.
        </p>
      ) : null}

      {state === 'ready' && runs.length === 0 ? (
        <p className="bench-note">No transcripts have been published for this corpus yet.</p>
      ) : null}

      {runs.length > 0 ? <RunsTable runs={runs} onTrace={setTrace} /> : null}

      <TraceDialog target={trace} onClose={() => setTrace(null)} />
    </div>
  );
}

/** A latency, in the units it reads best in — ms up to a second, then seconds. */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Ingot's own surfaces, set in bold so the eye finds the thing under test. */
function isProduct(adapter: string): boolean {
  return adapter.startsWith('ingot');
}

/** The runs, flat, with a trace one click away from each. */
function RunsTable({
  runs,
  onTrace,
}: {
  runs: readonly Run[];
  onTrace: (run: Run) => void;
}): ReactNode {
  const correct = runs.filter(({ run }) => run.correct).length;

  return (
    <>
      <p className="bench-runs-summary label label-sm">
        {runs.length} runs shown <span aria-hidden="true">·</span> {correct} correct{' '}
        <span aria-hidden="true">·</span> {runs.length - correct} wrong
      </p>
      <div className="bench-scroll">
        <table className="bench-runs">
          <thead>
            <tr>
              <th scope="col">run</th>
              <th scope="col">class</th>
              <th scope="col">adapter</th>
              <th scope="col">result</th>
              <th scope="col" className="bench-runs-num">
                calls
              </th>
              <th scope="col" className="bench-runs-num">
                tokens
              </th>
              <th scope="col" className="bench-runs-num">
                time
              </th>
              <th scope="col">
                <span className="bench-sr">trace</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map(({ question, run }) => (
              <tr key={`${question.id} ${run.adapter}`}>
                <th scope="row" className="bench-runs-id">
                  {question.id}
                </th>
                <td className="bench-runs-class label label-sm">{question.category}</td>
                <td>
                  <code className={isProduct(run.adapter) ? 'bench-runs-adapter-key' : undefined}>
                    {run.adapter}
                  </code>
                </td>
                <td>
                  <Verdict correct={run.correct} />
                </td>
                <td className="bench-runs-num">{run.calls.length}</td>
                <td className="bench-runs-num">{run.contextTokens.toLocaleString('en-GB')}</td>
                <td className="bench-runs-num">{formatMs(run.ms)}</td>
                <td className="bench-runs-trace">
                  <button
                    type="button"
                    className="bench-trace-btn"
                    onClick={() => onTrace({ question, run })}
                  >
                    Trace <span aria-hidden="true">↗</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Pass or fail as a badge: pass is filled, fail is outlined — a fact, not a grade. */
function Verdict({ correct }: { correct: boolean }): ReactNode {
  return (
    <span className={correct ? 'bench-badge bench-badge-pass' : 'bench-badge bench-badge-fail'}>
      {correct ? 'pass' : 'fail'}
    </span>
  );
}

/**
 * One run's trace, in a modal.
 *
 * A native `<dialog>` rather than a hand-rolled overlay: `showModal()` gives the
 * Escape key, the focus move, the inert background and the top-layer stacking
 * for free, and this is a static export with no room for a modal library. The
 * element is always in the tree so the ref is stable; an effect opens and
 * closes it as the selection changes, and its contents render only when there
 * is a run to show, so the empty page ships no trace markup.
 */
function TraceDialog({ target, onClose }: { target: Run | null; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (target && !element.open) element.showModal();
    if (!target && element.open) element.close();
    // A modal over a scrollable page that still scrolls behind it is the one
    // thing `showModal` does not fix on its own.
    document.body.style.overflow = target ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [target]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard way out is Escape, which `showModal()` handles natively and fires through `onClose`; the onClick below is the mouse-only backdrop convenience on top of it.
    <dialog
      ref={ref}
      className="bench-trace"
      aria-labelledby="bench-trace-q"
      onClose={onClose}
      // A click that lands on the dialog itself rather than on its content is a
      // click on the backdrop, and the expected way out of a modal.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {target ? <Trace run={target} onClose={onClose} /> : null}
    </dialog>
  );
}

/** The trace itself: the question, what it cost, the calls in order, the answer. */
function Trace({ run: { question, run }, onClose }: { run: Run; onClose: () => void }): ReactNode {
  const stats: readonly [string, ReactNode][] = [
    ['calls', run.calls.length],
    ['tokens read', run.contextTokens.toLocaleString('en-GB')],
    ['wall time', formatMs(run.ms)],
    ['result', <Verdict key="v" correct={run.correct} />],
  ];

  return (
    <div className="bench-trace-inner">
      <button type="button" className="bench-trace-close" onClick={onClose} aria-label="Close trace">
        <span aria-hidden="true">×</span>
      </button>

      <header className="bench-trace-card">
        <div className="bench-trace-kicker label label-sm">
          Question <span aria-hidden="true">·</span> Class: {question.category}
        </div>
        <h3 className="bench-trace-q" id="bench-trace-q">
          {question.question}
        </h3>
        <dl className="bench-trace-stats">
          {stats.map(([term, value]) => (
            <div key={term}>
              <dt className="label label-sm">{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="bench-rule label label-sm bench-trace-rule">
        <span>Tool calls in order</span>
        <span className="bench-rule-line" aria-hidden="true" />
      </div>

      {run.calls.length === 0 ? (
        <p className="bench-note bench-trace-empty">
          No tool calls — {run.adapter} answered from the prompt.
        </p>
      ) : (
        <ol className="bench-trace-calls">
          {run.calls.map((call, index) => (
            <li
              className={call.failed ? 'bench-call bench-call-failed' : 'bench-call'}
              // biome-ignore lint/suspicious/noArrayIndexKey: the transcript is ordered and immutable — position in the call list is the identity of a call, and nothing is inserted, removed or reordered.
              key={index}
            >
              <div className="bench-call-head">
                <span className="bench-call-idx label label-sm">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <code className="bench-call-name">{call.name}</code>
                {call.failed ? <span className="bench-call-tag label label-sm">failed</span> : null}
                <span className="bench-call-ms label label-sm">{formatMs(call.ms)}</span>
              </div>
              <pre className="bench-call-io">
                <code>{formatInput(call.input)}</code>
              </pre>
              <pre className="bench-call-io bench-call-out">
                <code>{call.output}</code>
              </pre>
            </li>
          ))}
        </ol>
      )}

      <div className="bench-trace-foot">
        <div>
          <div className="label label-sm">answer given</div>
          <p className={run.correct ? 'bench-trace-answer' : 'bench-trace-answer bench-trace-wrong'}>
            {summariseAnswer(run.answer)}
          </p>
        </div>
        <div>
          <div className="label label-sm">expected</div>
          <p className="bench-trace-answer">{summariseAnswer(question.gold)}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * A gold or an answer as a short line.
 *
 * Gold is `{ kind, value | values }` and an answer is whatever the model
 * submitted — usually the same shape, sometimes not. Both are rendered by the
 * same reader-facing rule so a question's gold and a column's answer can be
 * compared at a glance, which is the whole reason they sit on the same row.
 */
function summariseAnswer(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.length === 0 ? '∅' : value.map(String).join(', ');
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.values)) {
    return record.values.length === 0 ? '∅' : (record.values as unknown[]).map(String).join(', ');
  }
  if ('value' in record) return String(record.value);
  return JSON.stringify(value);
}

/**
 * A tool input as the reader would say it out loud.
 *
 * A lone string argument — the SQL, the search query — is the whole call and
 * reads best unadorned; anything with more than one field keeps its keys so a
 * `k` or a `limit` beside the query is not lost. Verbatim either way: this is
 * the half of the transcript the harness publishes uncapped.
 */
function formatInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  const only = keys[0];
  if (keys.length === 1 && only !== undefined && typeof input[only] === 'string') {
    return input[only] as string;
  }
  return JSON.stringify(input, null, 2);
}
