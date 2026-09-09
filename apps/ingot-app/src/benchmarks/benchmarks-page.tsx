import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { DOCS_HREF, REPO_URL, sourceHref, WHY_HREF } from '../site/mode';
// The landing page's layout, used rather than restated, the way `/why` uses
// it: this page is the same shape of document — a hero and ruled bands.
import '../landing/landing.css';
import './benchmarks.css';
import { Prose } from '../docs/prose';
import {
  ADAPTERS,
  arrival,
  BENCHMARK,
  BENCHMARKS_DESCRIPTION,
  BENCHMARKS_LEDE,
  CATEGORIES,
  CONTROL_NAMES,
  CORPUS_JOINS,
  CORPUS_LEDE,
  countWord,
  HAS_RESULTS,
  leadStats,
  mappingWriter,
  LIMITS,
  SOURCE_BLURBS,
  SOURCES,
  type PublishedAdapter,
} from './benchmarks';

export const benchmarksMetadata: Metadata = {
  title: 'Benchmarks',
  description: BENCHMARKS_DESCRIPTION,
};

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
  const { run, categories, adapters } = BENCHMARK;

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

          {run ? (
            <>
              <Tiles />
              <RankedAccuracy adapters={adapters} />
              <HeatMatrix categories={categories} adapters={adapters} />
              <Provenance />
              <CostTable adapters={adapters} />
              <Failures adapters={adapters} />
              <p className="bench-note">
                Evidence recall is the share of the answer-bearing records that came back through
                the tools; precision is the share of what came back that was answer-bearing. Both
                are computed only over questions whose answer is a set of records — see the limits
                below. Context tokens is what the model had to read to answer.
              </p>
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

          <CorpusShape />
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
              A benchmark published by the thing it measures has one obligation above all the
              others: say plainly where it is weak. These are the ones worth knowing before you read
              anything above.
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
              A benchmark published by the thing it measures is worth exactly as much as your
              ability to go and check it. Every part of this one is a single file, linked by the
              question it answers.
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
function Provenance(): ReactNode {
  const run = BENCHMARK.run;
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
      {run.warnings.map((warning) => (
        <p className="bench-warning" key={warning}>
          {warning}
        </p>
      ))}
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
function CorpusShape(): ReactNode {
  const { corpus, run } = BENCHMARK;
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
  const rawContext = BENCHMARK.adapters.find((adapter) => adapter.name === 'raw-context');

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
    </>
  );
}

/** A number as a share of the row, for the bar behind it. */
function bar(value: number): Record<string, string> {
  return { ['--v' as string]: String(Math.round(value * 100)) };
}

/** The three figures that lead the section, computed in `benchmarks.ts`. */
function Tiles(): ReactNode {
  const stats = leadStats();
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
