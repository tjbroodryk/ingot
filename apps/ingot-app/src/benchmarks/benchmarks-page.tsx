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

        <section className="landblock" id="questions">
          <div className="landhead">
            <span className="label label-sm kicker">[ The questions ]</span>
            <h2 className="landtitle">
              Six kinds of
              <br />
              <span className="mark">asking</span>
            </h2>
          </div>

          <dl className="bench-defs">
            {CATEGORIES.map((category) => (
              <div key={category.name}>
                <dt>
                  <code>{category.name}</code>
                  {run?.categoryCounts[category.name] !== undefined ? (
                    <span className="muted"> · {run.categoryCounts[category.name]} questions</span>
                  ) : null}
                </dt>
                <dd>{category.blurb}</dd>
              </div>
            ))}
          </dl>
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
          <div className="bench-tile-label label label-sm">{stat.label}</div>
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
    </li>
  );

  return (
    <div className="bench-ranked">
      <h3 className="bench-subhead label label-sm">Overall accuracy</h3>
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
 * Per-category accuracy as a shaded grid.
 *
 * Intensity encodes the value itself, which is a fact, and not a judgement
 * about it — one hue getting darker, never a red-to-green ramp. At these error
 * bars a good/bad palette would invent winners the run did not produce, and
 * the categories are where the differences are structural rather than narrow.
 */
function HeatMatrix({
  categories,
  adapters,
}: {
  categories: readonly string[];
  adapters: readonly PublishedAdapter[];
}): ReactNode {
  const byScore = (a: PublishedAdapter, b: PublishedAdapter): number => b.accuracy - a.accuracy;
  const ordered = [
    ...adapters.filter((a) => !CONTROL_NAMES.has(a.name)).sort(byScore),
    ...adapters.filter((a) => CONTROL_NAMES.has(a.name)).sort(byScore),
  ];

  return (
    <div className="bench-scroll">
      <h3 className="bench-subhead label label-sm">By question category</h3>
      <table className="bench-table bench-matrix">
        <thead>
          <tr>
            <th scope="col">adapter</th>
            {categories.map((category) => (
              <th scope="col" key={category}>
                {category}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((adapter) => (
            <tr key={adapter.name} className={CONTROL_NAMES.has(adapter.name) ? 'bench-ctl' : ''}>
              <th scope="row">
                <code>{adapter.name}</code>
              </th>
              {categories.map((category) => {
                const value = adapter.byCategory[category];
                if (value === undefined) {
                  return (
                    <td key={category} className="bench-na" aria-label="not applicable">
                      —
                    </td>
                  );
                }
                return (
                  <td key={category} className="bench-heat" style={bar(value)}>
                    {percent(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
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
