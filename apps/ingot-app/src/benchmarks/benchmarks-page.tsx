import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { DOCS_HREF, REPO_URL, WHY_HREF } from '../site/mode';
// The landing page's layout, used rather than restated, the way `/why` uses
// it: this page is the same shape of document — a hero and ruled bands.
import '../landing/landing.css';
import './benchmarks.css';
import {
  ADAPTERS,
  BENCHMARK,
  BENCHMARKS_DESCRIPTION,
  BENCHMARKS_LEDE,
  CATEGORIES,
  CONTROL_NAMES,
  HAS_RESULTS,
  leadStats,
  LIMITS,
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
              The categories are the design. Similarity search cannot aggregate, cannot express
              absence and cannot order — and it does well on meaning. A table that reported one
              number would be hiding which of those it was made of.
            </p>
          </div>

          {run ? (
            <>
              <Tiles />
              <RankedAccuracy adapters={adapters} />
              <HeatMatrix categories={categories} adapters={adapters} />
              <Provenance />
              <CostTable adapters={adapters} />
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
              <p>
                Nothing is written here by hand, so there are no numbers to show until there has
                been a run to produce them.
              </p>
            </div>
          )}
        </section>

        <section className="landblock" id="method">
          <div className="landhead">
            <span className="label label-sm kicker">[ What is compared ]</span>
            <h2 className="landtitle">
              Six memories,
              <br />
              <span className="mark">one agent</span>
            </h2>
            <p>
              One agent loop serves every column, with the same model, the same tool-call budget
              and the same answer channel. Only the retrieval tools differ, so a gap between two
              columns has one possible cause.
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
              A benchmark published by the thing it measures has one obligation above the rest:
              say plainly where it is weak. These are the ones worth knowing before reading
              anything above.
            </p>
          </div>

          <dl className="bench-defs">
            {LIMITS.map((limit) => (
              <div key={limit.title}>
                <dt>{limit.title}</dt>
                <dd>{limit.body}</dd>
              </div>
            ))}
          </dl>

          <div className="bench-strip">
            <p>
              The harness, the generator and the scorer are in <code>packages/bench</code>. Run it
              against your own seed and see whether it holds.
            </p>
            <div className="hero-actions label">
              <a className="btn-solid" href={REPO_URL}>
                Read the harness
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
    ['ingot schema', `${run.mapping}-written`],
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
 * controls keep their own group: `oracle` placed fourth in a race it was not
 * running is the wrong reading, and a flush list invites exactly that.
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
