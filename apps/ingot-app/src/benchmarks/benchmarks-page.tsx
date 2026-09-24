'use client';

// The directive is the first statement in the file and has to stay there: a
// comment above it is tolerated by TypeScript and not by the bundler, which
// silently builds this as a server component and fails at prerender with an
// undefined export rather than anything that names the cause.
//
// The page is a client component because the switch between published corpora,
// the sortable tables, the transcripts and the sticky contents are all state.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ContentsRail, type RailItem } from '../chrome/contents-rail';
import { sectionNumber } from '../chrome/section-number';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { BASE_PATH, DOCS_HREF, REPO_URL, sourceHref, WHY_HREF } from '../site/mode';
// The hero, the badge and the buttons are the landing page's, used rather than
// restated. The bands below them are this page's own.
import '../landing/landing.css';
import './benchmarks.css';
import { Prose } from '../docs/prose';
import {
  ADAPTERS,
  adapterLabel,
  arrival,
  BENCHMARK,
  BENCHMARKS_LEDE,
  CATEGORIES,
  classesIn,
  CONTROL_NAMES,
  CORPUS_JOINS,
  CORPUS_LEDE,
  countWord,
  HAS_RESULTS,
  leadStats,
  TABLES,
  mappingWriter,
  LIMITS,
  MATCHUP,
  SCALING,
  SOURCE_BLURBS,
  SOURCES,
  TRANSCRIPTS_FILE,
  type PublishedAdapter,
  type PublishedTable,
  type PublishedTranscripts,
  type TranscriptRun,
} from './benchmarks';
import { ScalingChart } from './scaling-chart';
import { headline, SmallModels } from './small-models';

const HAS_MATCHUP = headline(MATCHUP) !== null;

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const count = (value: number): string => value.toLocaleString('en-GB');

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
   * the same columns over different corpora, and a reader comparing them wants
   * to flick between them with the scroll position kept.
   */
  const [selected, setSelected] = useState(0);
  const table = TABLES[selected] ?? TABLES[0] ?? null;
  const transcripts = useTranscripts();
  // Memoised so the rail's scroll listener is not re-bound on every render.
  const sections = useMemo(() => contents(table), [table]);

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
          <h1 className="hero-title">
            But is it any
            <br />
            <span className="mark">good?</span>
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

        <div className="railbody">
          <aside className="railbody-aside">
            <ContentsRail items={sections} />
          </aside>

          <div className="railbody-main">
            {table ? <TheRun table={table} selected={selected} onSelect={setSelected} /> : null}

            <Band
              id="results"
              kicker="Results"
              title="Accuracy, and what it cost"
              lede="An answer counts only when it is exactly right. The bar is overall accuracy; Ctx tokens is the average prompt size, in tokens, the model read to produce each answer."
            >
              {table ? (
                <>
                  <Tiles table={table} />
                  <RankedAccuracy adapters={table.adapters} />
                  <Failures adapters={table.adapters} />
                  <CostTable adapters={table.adapters} concurrency={table.run.concurrency} />
                  {SCALING.points.length > 1 ? <ScalingChart scaling={SCALING} /> : null}
                </>
              ) : (
                <div className="bench-empty">
                  <h3>No run has been published yet.</h3>
                  <p>
                    The harness is in <code>packages/bench</code> and the method below is what it
                    does. This page fills in when a run is published into it:
                  </p>
                  <pre className="bench-pre">
                    <code>
                      bun run bench --publish ../../apps/ingot-app/src/benchmarks/results.json
                    </code>
                  </pre>
                </div>
              )}
            </Band>

            {HAS_MATCHUP ? (
              <Band
                id="small-models"
                kicker="Small models"
                title="Get more out of small models"
                lede="Exact tool answers leave the model less to reason about. So a small model with Ingot should keep up with a large one that searches a vector store and reads the raw data behind it."
              >
                <SmallModels matchup={MATCHUP} />
              </Band>
            ) : null}

            {table ? (
              <Band
                id="classes"
                kicker="By task class"
                title="Where each one breaks"
                lede="Aggregates, absence, ordering and joins are where structure should tell; the semantic questions are where embeddings should perform better."
              >
                <HeatMatrix categories={table.categories} adapters={table.adapters} />
              </Band>
            ) : null}

            <Band
              id="questions"
              kicker="The questions"
              title={table ? `${table.run.questions} questions` : 'The questions'}
              lede="A generator builds a world, renders it as the paginated JSON an agent would have received, and computes the gold answer from the world objects. Nothing is annotated by hand. Open a shape to read the questions it asks."
            >
              <QuestionShapes table={table} transcripts={transcripts} />
            </Band>

            <Band
              id="corpus"
              kicker="What it is asked about"
              title="Tool results, not documents"
              lede={CORPUS_LEDE}
            >
              <CorpusShape table={table} />
            </Band>

            {table ? (
              <Band
                id="transcripts"
                kicker="Transcripts"
                title="Read the runs"
                lede="All of the above results are derived from these transcripts."
              >
                <Transcripts table={table} transcripts={transcripts} />
              </Band>
            ) : null}

            <Band
              id="method"
              kicker="What is compared"
              // "Columns" rather than "memories", because `raw-context` is not one:
              // it answers from the prompt and is a reference point. The heading
              // counting the columns and the grid listing that many cells is the
              // agreement that matters.
              title={`${countWord(ADAPTERS.length)} comparisons, same agent harness`}
              lede={
                <>
                  One agent harness implementation serves every test case, with the same model and
                  settings so results <i>should</i> only differ due to the tool results.
                </>
              }
            >
              <div className="bench-cells">
                {ADAPTERS.map((adapter) => (
                  <div className="bench-cell" key={adapter.name}>
                    <div className="bench-cell-key">{adapterLabel(adapter.name).toUpperCase()}</div>
                    <p>{adapter.blurb}</p>
                  </div>
                ))}
              </div>
            </Band>

            <Band
              id="limits"
              kicker="Caveats"
              title="What this does not measure"
              lede="We are publishing a benchmark of our own software. Discount it accordingly, and start here."
            >
              <div className="bench-cells">
                {LIMITS.map((limit) => (
                  <div className="bench-cell" key={limit.title}>
                    <h3 className="bench-cell-title">{limit.title}</h3>
                    <p>{limit.body}</p>
                  </div>
                ))}
              </div>
            </Band>

            <Band
              id="check"
              kicker="Check it"
              title="View our test cases"
              lede="This is worth exactly as much as your ability to go and check it, so every part of it is one file, linked below by the question it answers. If you want to know whether we shaped the questions to flatter ourselves, you can read the generator."
            >
              <div className="bench-cells">
                {SOURCES.map((source) => (
                  <div className="bench-cell" key={source.path}>
                    <h3 className="bench-cell-title">
                      <a href={sourceHref(source.path)}>{source.question}</a>
                    </h3>
                    <p>{source.detail}</p>
                    <code className="bench-cell-path">{source.path}</code>
                  </div>
                ))}
              </div>

              <p className="bench-caption">
                Or run it yourself against a seed of your own — <code>--dry-run</code> prints every
                question and every gold answer without spending anything.
              </p>
              <div className="bench-actions label">
                <a className="btn-solid" href={sourceHref('packages/bench/README.md')}>
                  The methodology <span aria-hidden="true">→</span>
                </a>
                <a
                  className="btn-outline"
                  href={sourceHref('packages/bench/src/questions/questions.ts')}
                >
                  Read the question set
                </a>
                <a className="btn-outline" href={DOCS_HREF}>
                  View docs
                </a>
              </div>
            </Band>
          </div>
        </div>
      </div>

      <SiteFooter />
    </>
  );
}

/**
 * The rail's entries, in the order they render: the run's setup as `00`, then
 * the numbered bands.
 *
 * Filtered by the same conditions the bands are, so the numbers here always
 * agree with the `[ 0n ]` counters on the kickers.
 */
function contents(table: PublishedTable | null): readonly RailItem[] {
  const bands: readonly (RailItem & { readonly needsRun: boolean; readonly shown?: boolean })[] = [
    { id: 'results', title: 'Results', needsRun: false },
    { id: 'small-models', title: 'Small models', needsRun: false, shown: HAS_MATCHUP },
    { id: 'classes', title: 'Task class', needsRun: true },
    { id: 'questions', title: 'Questions', needsRun: false },
    { id: 'corpus', title: 'Corpus', needsRun: false },
    { id: 'transcripts', title: 'Transcripts', needsRun: true },
    { id: 'method', title: 'Compared', needsRun: false },
    { id: 'limits', title: 'Caveats', needsRun: false },
    { id: 'check', title: 'Check it', needsRun: false },
  ];
  const numbered = bands
    .filter((band) => (table || !band.needsRun) && band.shown !== false)
    .map(({ id, title }, index) => ({ id, title, n: sectionNumber(index) }));
  return table ? [{ id: 'setup', title: 'Setup', n: '00' }, ...numbered] : numbered;
}

/** A numbered band: a centred kicker, title and lede over whatever it holds. */
function Band({
  id,
  kicker,
  title,
  lede,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  lede: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="bench-band" id={id}>
      <div className="bench-wrap">
        <span className="label kicker kicker-n">{kicker}</span>
        <h2 className="bench-title">{title}</h2>
        <p className="bench-lede">{lede}</p>
        {children}
      </div>
    </section>
  );
}

/** A mono label with a rule running to the far edge, and a legend at the end. */
function Rule({ label, legend }: { label: string; legend?: ReactNode }): ReactNode {
  return (
    <div className="bench-rule label label-sm">
      <span>{label}</span>
      <span className="bench-rule-line" aria-hidden="true" />
      {legend ? <span>{legend}</span> : null}
    </div>
  );
}

/**
 * The transcripts, fetched once for the whole page.
 *
 * The question shapes and the transcript list read the same file, so one
 * fetch serves both. Nothing is fetched on load: they are megabytes, and most
 * readers never open either.
 */
function useTranscripts(): Transcripts {
  const [state, setState] = useState<Transcripts['state']>('idle');
  const [data, setData] = useState<PublishedTranscripts | null>(null);

  const load = async (): Promise<void> => {
    if (state === 'loading' || state === 'ready') return;
    setState('loading');
    try {
      // Through BASE_PATH, so the fetch resolves when the site is served from a
      // subdirectory (GitHub Pages puts a project site under `/<repo>/`).
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

  return { state, data, load };
}

interface Transcripts {
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly data: PublishedTranscripts | null;
  readonly load: () => Promise<void>;
}

/** The selected corpus's runs, grouped by question in the sidecar's order. */
function runsFor(transcripts: Transcripts, label: string): readonly TranscriptRun[] {
  const forThis = transcripts.data?.tables.find((one) => one.label === label);
  return (
    forThis?.questions.flatMap((question) => question.adapters.map((run) => ({ question, run }))) ??
    []
  );
}

/* ── the run ───────────────────────────────────────────────────────────── */

/**
 * What produced the numbers, above the numbers.
 *
 * The corpus switch sits here because which corpus a table was measured over
 * is not a filter on the table — it is what the table is — and every section
 * below this one moves with it.
 */
function TheRun({
  table,
  selected,
  onSelect,
}: {
  table: PublishedTable;
  selected: number;
  onSelect: (index: number) => void;
}): ReactNode {
  const { run } = table;
  const agentRuns = table.adapters.reduce((sum, adapter) => sum + adapter.runs, 0);

  const config: readonly [string, string][] = [
    ['Seed', String(run.seed)],
    ['Runs per question', String(run.repeats)],
    ['Questions', String(run.questions)],
    ['Tool-call budget', String(run.maxToolCalls)],
    ['Agent runs', count(agentRuns)],
    ['Ingot column mapping', mappingWriter(run.mapping)],
  ];

  return (
    <section className="bench-run" id="setup" aria-label="The run">
      <div className="bench-wrap">
        <Rule
          label="The run"
          // Kept when the run stamp went, because how old a benchmark is changes
          // what it is worth — a table with no date is a table nobody can age.
          legend={BENCHMARK.generatedAt ? `Published ${BENCHMARK.generatedAt.slice(0, 10)}` : null}
        />

        {TABLES.length > 1 ? (
          <div className="bench-switch label label-sm">
            <span className="bench-switch-legend">measured over</span>
            {TABLES.map((option, index) => (
              <button
                aria-pressed={index === selected}
                className="bench-switch-option"
                key={option.label}
                onClick={() => onSelect(index)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="bench-spec">
          <div className="bench-spec-cell bench-spec-lead">
            <div className="bench-spec-label label">Model under test</div>
            <div className="bench-spec-model">{run.model}</div>
            <div className="bench-spec-sub">
              on {run.provider} · reasoning {run.thinking ? run.effort : 'off'}
            </div>
            <p>
              Every column below is answered by this one model through the same agent loop. Only the
              retrieval tools change.
            </p>
          </div>
          <div className="bench-spec-cell">
            <div className="bench-spec-label label">Embedder</div>
            <div className="bench-spec-value">{run.embedder}</div>
            <p>One embedder across the whole table, including the hosted indexes.</p>
          </div>
          <div className="bench-spec-cell">
            <div className="bench-spec-label label">Scoring</div>
            <div className="bench-spec-value">No judge model</div>
            <p>Exact match, decided by code. No partial credit.</p>
          </div>
        </div>

        <dl className="bench-config">
          {config.map(([term, value]) => (
            <div key={term}>
              <dt className="label">{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        <Scoring />
      </div>
    </section>
  );
}

/** How `packages/bench/src/score/score.ts` gets from an answer to a verdict. */
const SCORING_STEPS: readonly [string, string][] = [
  [
    'The correct answer',
    'The corpus comes from a fixed seed, so the harness knows the true state of the fake project and computes each answer from it. For “which team owns the service with the most open issues since 2026-04-01” it counts open issues per service, takes the top one and looks up its owner: `infra`.',
  ],
  [
    'The submission',
    'The model has to answer through a `submit_answer` tool. Text in the reply doesn’t count.',
  ],
  [
    'Normalised',
    'Both sides are lower-cased and trimmed. A comma-separated string is accepted in place of an array.',
  ],
  ['Compared', 'By the type of answer, with the rules below.'],
];

const ANSWER_TYPES: readonly [string, string][] = [
  ['Number', 'Exactly equal.'],
  ['Ordered list', 'The same items in the same order.'],
  ['Set', 'Exactly the right items: nothing missing and nothing extra.'],
];

const SCORING_NOTES: readonly [string, string][] = [
  [
    'Counts as wrong',
    'Not submitting at all: running out of tool calls, a timeout, or a context overflow. Overflows are tagged separately, so the results can say why.',
  ],
  [
    'The ± on each number',
    'The binomial standard error, `√(p(1−p)/n)`, where n is the number of attempts. It gets large when n is small: at 6 attempts it’s about ±15–20 points in the middle of the range.',
  ],
  [
    'Evidence recall and precision',
    'Scored separately, by scanning tool output for the record ids that support the answer. They check what came back through the tools, and don’t affect accuracy.',
  ],
];

/* ── results ───────────────────────────────────────────────────────────── */

/** The three figures that lead the section, computed in `benchmarks.ts`. */
function Tiles({ table }: { table: PublishedTable }): ReactNode {
  const stats = leadStats(table);
  if (stats.length === 0) return null;
  return (
    <div className="bench-tiles">
      {stats.map((stat) => (
        <div className="bench-tile" key={stat.label}>
          <div className="bench-tile-value">{stat.value}</div>
          <div className="bench-tile-label label">
            {stat.label} ·{' '}
            {stat.subjects.map((subject, index) => (
              <span key={subject}>
                {index > 0 ? ' to ' : ''}
                <span className="bench-tile-subject">{subject}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type SortKey = 'name' | 'accuracy' | 'tokens';

/** Ingot's own surfaces, set in bold and the accent so the eye finds the thing under test. */
function isProduct(adapter: string): boolean {
  return adapter.startsWith('ingot');
}

/**
 * Overall accuracy as a ranked bar list, sortable by any of its columns.
 *
 * The control keeps its own group below a rule, drawn as an unfilled outline:
 * `raw-context` placed fourth in a race it was not running is the wrong
 * reading, and a flush list invites exactly that.
 */
function RankedAccuracy({ adapters }: { adapters: readonly PublishedAdapter[] }): ReactNode {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'accuracy',
    desc: true,
  });

  const compare = (a: PublishedAdapter, b: PublishedAdapter): number => {
    const flip = sort.desc ? -1 : 1;
    if (sort.key === 'name') return adapterLabel(a.name).localeCompare(adapterLabel(b.name)) * flip;
    if (sort.key === 'tokens') return (a.contextTokens - b.contextTokens) * flip;
    return (a.accuracy - b.accuracy) * flip;
  };
  const memories = adapters.filter((a) => !CONTROL_NAMES.has(a.name)).sort(compare);
  const controls = adapters.filter((a) => CONTROL_NAMES.has(a.name));

  const head = (key: SortKey, label: string, end: boolean): ReactNode => {
    const active = sort.key === key;
    return (
      <button
        type="button"
        className={`bench-sort${active ? ' bench-sort-on' : ''}${end ? ' bench-sort-end' : ''}`}
        onClick={() =>
          setSort((now) => ({
            key,
            // Names read A–Z first; figures read highest first.
            desc: now.key === key ? !now.desc : key !== 'name',
          }))
        }
      >
        {label}
        <span aria-hidden="true">{active ? (sort.desc ? '↓' : '↑') : '↕'}</span>
        {active ? (
          <span className="bench-sr">, sorted {sort.desc ? 'descending' : 'ascending'}</span>
        ) : null}
      </button>
    );
  };

  const row = (adapter: PublishedAdapter, control: boolean): ReactNode => (
    <li
      className={`bench-rank${control ? ' bench-rank-ctl' : ''}${isProduct(adapter.name) ? ' bench-rank-ours' : ''}`}
      key={adapter.name}
    >
      <code className="bench-rank-name">{adapterLabel(adapter.name)}</code>
      <span className="bench-rank-track">
        <span className="bench-rank-fill" style={bar(adapter.accuracy)} aria-hidden="true" />
      </span>
      <span className="bench-rank-value">
        <strong>{percent(adapter.accuracy)}</strong>
        <span className="bench-rank-err">±{percent(adapter.stderr)}</span>
      </span>
      <span className="bench-rank-cost">{count(adapter.contextTokens)}</span>
    </li>
  );

  return (
    <div className="bench-ranked">
      <div className="bench-rank bench-rank-head label label-sm">
        {head('name', 'Adapter', false)}
        <span className="bench-rank-head-bar">Overall accuracy</span>
        {head('accuracy', 'Score', true)}
        {head('tokens', 'Ctx tokens', true)}
      </div>
      <ol className="bench-ranks">{memories.map((adapter) => row(adapter, false))}</ol>
      {controls.length > 0 ? (
        <div className="bench-ceiling">
          <h3 className="bench-ceiling-label label label-sm">
            The ceiling — no retrieval, whole corpus in the prompt
          </h3>
          <ol className="bench-ranks">{controls.map((adapter) => row(adapter, true))}</ol>
        </div>
      ) : null}
    </div>
  );
}

/** A number as a share of the row, for the bar behind it. */
function bar(value: number): Record<string, string> {
  return { ['--v' as string]: String(Math.round(value * 100)) };
}

/**
 * Runs that never happened, named beside the numbers they dragged down.
 *
 * A provider throwing is scored as a wrong answer — a memory that could not be
 * asked did not answer — and that is the right call for the accuracy column.
 * It is the wrong thing to leave unsaid, because "this adapter did badly" and
 * "a fifth of this adapter's runs died on a rate limit" are different readings
 * of the same figure, and only the first one is about retrieval.
 */
function Failures({ adapters }: { adapters: readonly PublishedAdapter[] }): ReactNode {
  const hit = adapters.filter((adapter) => adapter.failures > 0);
  if (hit.length === 0) return null;

  const total = hit.reduce((sum, adapter) => sum + adapter.failures, 0);
  const runs = adapters.reduce((sum, adapter) => sum + adapter.runs, 0);

  return (
    <p className="bench-caption">
      {`${total} of ${runs} agent runs failed outright — the provider threw and nothing was answered: `}
      {hit.map((adapter, index) => (
        <span key={adapter.name}>
          {index > 0 ? ', ' : ''}
          <code>{adapterLabel(adapter.name)}</code> {adapter.failures} of {adapter.runs}
        </span>
      ))}
      {'. They are scored wrong, because a memory that could not be asked did not answer — but ' +
        'they are infrastructure failures rather than retrieval failures, and a column carrying ' +
        'several of them is reading lower than what it did with the questions it got.'}
    </p>
  );
}

function Scoring(): ReactNode {
  return (
    <div className="bench-scoring" id="scoring">
      <Rule label="How accuracy is scored" />
      <h3 className="bench-scoring-title">Exactly right, or wrong</h3>
      <p className="bench-scoring-lede">
        Accuracy is the share of attempts where the submitted answer exactly matches the correct
        one. Code decides it, in{' '}
        <a href={sourceHref('packages/bench/src/score/score.ts')}>
          <code>src/score/score.ts</code>
        </a>
        . No model grades the answers.
      </p>

      <ol className="bench-scoring-steps">
        {SCORING_STEPS.map(([title, body], index) => (
          <li key={title}>
            <span className="bench-scoring-n label">{String(index + 1).padStart(2, '0')}</span>
            <span className="bench-scoring-step label">{title}</span>
            <p>
              <Prose text={body} />
            </p>
          </li>
        ))}
      </ol>

      <table className="bench-scoring-types">
        <thead>
          <tr className="label label-sm">
            <th scope="col" className="bench-scoring-col bench-scoring-col-type">
              Answer type
            </th>
            <th scope="col" className="bench-scoring-col">
              Correct when
            </th>
          </tr>
        </thead>
        <tbody>
          {ANSWER_TYPES.map(([type, rule]) => (
            <tr key={type}>
              <th scope="row" className="bench-scoring-type label">
                {type}
              </th>
              <td className="bench-scoring-rule">{rule}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="bench-scoring-callout">
        <span className="bench-scoring-badge label label-sm">No partial credit</span>
        <p>
          An answer of <code>svc:billing</code> scored as wrong, even though the model had found the
          right team, <code>infra</code>, on the way. Partial credit is recorded separately as F1
          (the “set F1” column) and doesn’t count towards accuracy.
        </p>
      </div>

      <dl className="bench-scoring-notes">
        {SCORING_NOTES.map(([term, body]) => (
          <div key={term}>
            <dt className="label label-sm">{term}</dt>
            <dd>
              <Prose text={body} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** One column of the averages table: what it reads, how it prints, which way is better. */
interface CostColumn {
  readonly key: string;
  readonly label: string;
  readonly value: (adapter: PublishedAdapter) => number | null;
  readonly show: (value: number) => string;
  /** The first click on a column puts the best first. */
  readonly higherIsBetter: boolean;
}

const COST_COLUMNS: readonly CostColumn[] = [
  {
    key: 'f1',
    label: 'set F1',
    value: (a) => a.f1,
    show: (v) => v.toFixed(2),
    higherIsBetter: true,
  },
  {
    key: 'recall',
    label: 'evidence recall',
    value: (a) => a.evidenceRecall,
    show: percent,
    higherIsBetter: true,
  },
  {
    key: 'precision',
    label: 'evidence precision',
    value: (a) => a.evidencePrecision,
    show: percent,
    higherIsBetter: true,
  },
  {
    key: 'calls',
    label: 'tool calls',
    value: (a) => a.toolCalls,
    show: (v) => v.toFixed(1),
    higherIsBetter: false,
  },
  {
    key: 'tokens',
    label: 'context tokens',
    value: (a) => a.contextTokens,
    show: count,
    higherIsBetter: false,
  },
  {
    key: 'callMs',
    label: 'tool-call latency',
    value: (a) => a.callMs ?? null,
    show: formatMs,
    higherIsBetter: false,
  },
  {
    key: 'runMs',
    label: 'run time',
    value: (a) => a.runMs ?? null,
    show: formatMs,
    higherIsBetter: false,
  },
];

/** Everything beyond accuracy, averaged per run and sortable by any column. */
function CostTable({
  adapters,
  concurrency,
}: {
  adapters: readonly PublishedAdapter[];
  concurrency: number;
}): ReactNode {
  // Null is the published order, which is the order the run bought them in.
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);

  const column = COST_COLUMNS.find((one) => one.key === sort?.key);
  const rows = [...adapters];
  if (sort?.key === 'name') {
    rows.sort(
      (a, b) => adapterLabel(a.name).localeCompare(adapterLabel(b.name)) * (sort.desc ? -1 : 1),
    );
  } else if (sort && column) {
    rows.sort((a, b) => {
      const left = column.value(a);
      const right = column.value(b);
      // A column with no value for an adapter (`—`) sorts last either way.
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return (left - right) * (sort.desc ? -1 : 1);
    });
  }

  const header = (key: string, label: string, firstDesc: boolean): ReactNode => {
    const active = sort?.key === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}
        key={key}
      >
        <button
          type="button"
          className={`bench-sort${active ? ' bench-sort-on' : ''}${key === 'name' ? '' : ' bench-sort-end'}`}
          onClick={() =>
            setSort((now) => ({ key, desc: now?.key === key ? !now.desc : firstDesc }))
          }
        >
          {label}
          <span aria-hidden="true">{active ? (sort.desc ? '↓' : '↑') : '↕'}</span>
        </button>
      </th>
    );
  };

  return (
    <div className="bench-block">
      <Rule label="Beyond the answer" legend="Averages per run" />
      <div className="bench-scroll">
        <table className="bench-table">
          <thead>
            <tr>
              {header('name', 'adapter', false)}
              {COST_COLUMNS.map((one) => header(one.key, one.label, one.higherIsBetter))}
            </tr>
          </thead>
          <tbody>
            {rows.map((adapter) => (
              <tr key={adapter.name}>
                <th scope="row">
                  <code className={isProduct(adapter.name) ? 'bench-ours' : undefined}>
                    {adapterLabel(adapter.name)}
                  </code>
                </th>
                {COST_COLUMNS.map((one) => {
                  const value = one.value(adapter);
                  return <td key={one.key}>{value === null ? '—' : one.show(value)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="bench-caption">
        Tool-call latency is the time one retrieval call took; run time is the whole answer, the
        model's own thinking included.
        {concurrency > 1
          ? ` Both were measured with ${concurrency} agent runs in flight at once, so they compare the columns with each other and not with a run that had the provider to itself.`
          : ''}
      </p>
    </div>
  );
}

/* ── by task class ─────────────────────────────────────────────────────── */

/**
 * The step of the accent ramp a value falls on, 1 to 5.
 *
 * Stepped rather than continuous so five fills can be told apart at a glance,
 * and read against the legend under the matrix.
 */
function heatStep(value: number): number {
  const pct = Math.round(value * 100);
  if (pct >= 90) return 5;
  if (pct >= 70) return 4;
  if (pct >= 50) return 3;
  if (pct >= 30) return 2;
  return 1;
}

/**
 * Per-category accuracy as a heat matrix.
 *
 * A real table, because it is tabular data and a screen reader should get row
 * and column headers — but spaced and filled so the eye reads it as a grid of
 * blocks rather than a wall of numerals.
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
      const shown = Math.round(value * 100);
      if (control) {
        return (
          <td key={category} className="bench-heat bench-heat-ctl">
            {shown}
          </td>
        );
      }
      return (
        <td
          key={category}
          className={`bench-heat ${value === 0 ? 'bench-heat-zero' : `bench-heat-${heatStep(value)}`}`}
        >
          {shown}
        </td>
      );
    });

  return (
    <>
      <div className="bench-scroll">
        <table className="bench-matrix">
          <thead>
            <tr>
              <th scope="col">
                <span className="bench-sr">adapter</span>
              </th>
              {categories.map((category) => (
                <th scope="col" key={category}>
                  <a href={`#shape-${category}`}>{category}</a>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {memories.map((adapter) => (
              <tr key={adapter.name}>
                <th scope="row" className={isProduct(adapter.name) ? 'bench-ours' : undefined}>
                  {adapterLabel(adapter.name)}
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
                  <th scope="row">{adapterLabel(adapter.name)}</th>
                  {cells(adapter, true)}
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
      </div>

      <div className="bench-legend label label-sm">
        <span>Darker is higher</span>
        <span className="bench-legend-ramp" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((step) => (
            <span key={step} className={`bench-heat-${step}`} />
          ))}
        </span>
        <span>
          <span className="bench-legend-ctl" aria-hidden="true" /> the ceiling
        </span>
      </div>
    </>
  );
}

/* ── the questions ─────────────────────────────────────────────────────── */

/**
 * One card per question class: what it is for, what its gold is, and — on a
 * click — every question the run asked in it.
 *
 * The questions come out of the transcripts, so opening a card is the same
 * fetch the transcripts section makes, and neither makes it twice.
 */
function QuestionShapes({
  table,
  transcripts,
}: {
  table: PublishedTable | null;
  transcripts: Transcripts;
}): ReactNode {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const runs = table ? runsFor(transcripts, table.label) : [];

  const toggle = (name: string): void => {
    void transcripts.load();
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <>
      <div className="bench-shapes">
        {CATEGORIES.map((category) => {
          const asked = table?.run.categoryCounts[category.name];
          const isOpen = open.has(category.name);
          // One entry per question, not per run: the sidecar lists each question once.
          const questions = runs
            .filter(({ question }) => question.category === category.name)
            .map(({ question }) => question)
            .filter((question, index, all) => all.findIndex((q) => q.id === question.id) === index);

          return (
            <div
              className={isOpen ? 'bench-shape bench-shape-open' : 'bench-shape'}
              id={`shape-${category.name}`}
              key={category.name}
            >
              <div className="bench-shape-name label">{category.name}</div>
              <p>{category.blurb}</p>

              {table && asked ? (
                <button
                  type="button"
                  className="bench-shape-toggle"
                  aria-expanded={isOpen}
                  onClick={() => toggle(category.name)}
                >
                  <span className="bench-glyph" aria-hidden="true">
                    {isOpen ? '−' : '+'}
                  </span>
                  <span className="label label-sm">
                    {isOpen
                      ? 'Hide the questions'
                      : `Read the ${asked} question${asked === 1 ? '' : 's'} asked`}
                  </span>
                </button>
              ) : null}

              {isOpen ? (
                <div className="bench-shape-list">
                  {transcripts.state === 'loading' ? (
                    <p className="bench-shape-note label label-sm">Loading the questions…</p>
                  ) : null}
                  {transcripts.state === 'error' ? (
                    <p className="bench-shape-note label label-sm">
                      The questions could not be loaded.
                    </p>
                  ) : null}
                  {questions.map((question) => (
                    <p className="bench-shape-q" key={question.id}>
                      <Prose text={question.question} />
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {table ? (
        <p className="bench-caption">
          {`The corpus is ${count(table.corpus.results)} payloads and ${count(table.corpus.records)} records of tool output from ${table.corpus.sources.length} tools. Nothing declares a key, so the joins run on a file path in one payload and a service name in another.`}
        </p>
      ) : null}
    </>
  );
}

/* ── the corpus ────────────────────────────────────────────────────────── */

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
  // the corpus in tokens plus a question.
  const rawContext = table?.adapters.find((adapter) => adapter.name === 'raw-context');

  const facts: readonly [string, string][] = corpus
    ? [
        ['Payloads', count(corpus.results)],
        ['Records', count(corpus.records)],
        ['Characters of JSON', count(corpus.bytes)],
        ...(rawContext
          ? ([['Tokens, in raw-context’s prompt', count(rawContext.contextTokens)]] as [
              string,
              string,
            ][])
          : []),
      ]
    : [];

  return (
    <>
      {facts.length > 0 ? (
        <dl className="bench-config bench-config-open">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt className="label">{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/*
        Between the totals and the samples, because it is the fact that makes
        the samples mean something: six payloads that describe themselves and
        nothing else, joined only by values that happen to match.
      */}
      <div className="bench-block bench-joins">
        <Rule label="What joins them" legend="No schema, no keys" />
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

      <div className="bench-block">
        <Rule label="Each payload, verbatim" legend={table ? table.label : null} />
        <div className="bench-sources">
          {entries.map(({ source, blurb }) => {
            const tool = source?.tool ?? blurb?.tool ?? '';
            return (
              <div className="bench-source" key={tool}>
                <div className="bench-source-head">
                  <code className="bench-source-tool">{tool}</code>
                  {blurb ? (
                    <span className="label label-sm bench-source-shape">{blurb.shape}</span>
                  ) : null}
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
      </div>

      {run && run.logs === 0 ? (
        <p className="bench-caption">
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

/* ── transcripts ───────────────────────────────────────────────────────── */

function Transcripts({
  table,
  transcripts,
}: {
  table: PublishedTable;
  transcripts: Transcripts;
}): ReactNode {
  const { state } = transcripts;
  const runs = runsFor(transcripts, table.label);

  return (
    <div className="bench-transcripts">
      {state === 'idle' ? (
        <div className="bench-transcripts-prompt">
          <p>
            Load the transcripst to see how the model actually, interacted with the various
            questions and tools
          </p>
          <button className="btn-solid" type="button" onClick={() => void transcripts.load()}>
            Show the transcripts
          </button>
        </div>
      ) : null}

      {state === 'loading' ? <p className="bench-caption">Loading the transcripts…</p> : null}

      {state === 'error' ? (
        <p className="bench-caption">
          The transcripts could not be loaded. They are a separate file published beside the
          numbers, and a run from before transcript publishing has none to show.
        </p>
      ) : null}

      {state === 'ready' && runs.length === 0 ? (
        <p className="bench-caption">No transcripts have been published for this corpus yet.</p>
      ) : null}

      {runs.length > 0 ? <RunList runs={runs} /> : null}
    </div>
  );
}

/** A latency, in the units it reads best in — ms up to a second, then seconds. */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

const runKey = ({ question, run }: TranscriptRun): string => `${question.id}\u0000${run.adapter}`;

/** The runs, grouped by question, each opening its trace in place. */
function RunList({ runs }: { runs: readonly TranscriptRun[] }): ReactNode {
  /*
   * Which class of question the list is showing, or every class. Checked
   * against the classes actually present and falling back to all of them, so
   * switching to a corpus with no questions in the chosen class never leaves
   * an empty list with its cause two sections up.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [browsing, setBrowsing] = useState<number | null>(null);

  const classes = classesIn(runs);
  const showing = classes.some((one) => one.name === chosen) ? chosen : null;
  const shown =
    showing === null ? runs : runs.filter(({ question }) => question.category === showing);
  const correct = shown.filter(({ run }) => run.correct).length;
  const allOpen = shown.length > 0 && shown.every((one) => open.has(runKey(one)));

  const toggle = (key: string): void =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Consecutive runs of one question make a group; the sidecar already orders them so.
  const groups: TranscriptRun[][] = [];
  for (const one of shown) {
    const last = groups[groups.length - 1];
    if (last && last[0]?.question.id === one.question.id) last.push(one);
    else groups.push([one]);
  }

  return (
    <>
      {classes.length > 1 ? (
        <div className="bench-switch bench-switch-inline label label-sm">
          <span className="bench-switch-legend">class</span>
          <button
            aria-pressed={showing === null}
            className="bench-switch-option"
            onClick={() => setChosen(null)}
            type="button"
          >
            all <span className="muted">{runs.length}</span>
          </button>
          {classes.map(({ name, count: runsIn }) => (
            <button
              aria-pressed={showing === name}
              className="bench-switch-option"
              key={name}
              onClick={() => setChosen(name)}
              type="button"
            >
              {name} <span className="muted">{runsIn}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="bench-runs-bar">
        <p className="bench-runs-summary label label-sm">
          {shown.length} runs shown
          {showing === null ? '' : ` of ${runs.length}`} <span aria-hidden="true">·</span> {correct}{' '}
          correct <span aria-hidden="true">·</span> {shown.length - correct} wrong
        </p>
        <div className="bench-runs-actions label label-sm">
          <button
            type="button"
            className="bench-btn"
            onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map(runKey)))}
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
          <button
            type="button"
            className="bench-btn bench-btn-primary"
            onClick={() => setBrowsing(0)}
          >
            Browse all {shown.length} transcripts <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>

      {groups.map((group) => {
        const question = (group[0] as TranscriptRun).question;
        return (
          <div className="bench-group" key={question.id}>
            <QuestionHead question={question} />
            {group.map((one) => {
              const key = runKey(one);
              const isOpen = open.has(key);
              const { run } = one;
              return (
                <div
                  className={isOpen ? 'bench-attempt bench-attempt-open' : 'bench-attempt'}
                  key={key}
                >
                  <button
                    type="button"
                    className="bench-run-row"
                    aria-expanded={isOpen}
                    onClick={() => toggle(key)}
                  >
                    <span className="bench-glyph" aria-hidden="true">
                      {isOpen ? '−' : '+'}
                    </span>
                    <code className={isProduct(run.adapter) ? 'bench-ours' : undefined}>
                      {adapterLabel(run.adapter)}
                    </code>
                    <Verdict correct={run.correct} />
                    <span className="bench-run-num">
                      {run.calls.length} call{run.calls.length === 1 ? '' : 's'}
                    </span>
                    <span className="bench-run-num">{count(run.contextTokens)} tok</span>
                    <span className="bench-run-cta label label-sm">
                      {isOpen ? 'Hide transcript' : 'Read transcript'}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="bench-run-trace">
                      <Trace run={one} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}

      <Browser runs={shown} at={browsing} onPick={setBrowsing} onClose={() => setBrowsing(null)} />
    </>
  );
}

/** A question as the head of its runs: id, class, and the words. */
function QuestionHead({ question }: { question: TranscriptRun['question'] }): ReactNode {
  return (
    <div className="bench-q">
      <div className="bench-q-meta label label-sm">
        <span className="bench-q-id">{question.id}</span>
        <span>{question.category}</span>
      </div>
      <p className="bench-q-text">
        <Prose text={question.question} />
      </p>
    </div>
  );
}

/** Pass or fail as a badge: pass is filled, fail is outlined — a fact, not a grade. */
function Verdict({ correct }: { correct: boolean }): ReactNode {
  return (
    <span className={correct ? 'bench-badge bench-badge-pass' : 'bench-badge bench-badge-fail'}>
      {correct ? 'Correct' : 'Wrong'}
    </span>
  );
}

/**
 * Every run in a modal: the list on the left, one trace on the right.
 *
 * A native `<dialog>` rather than a hand-rolled overlay: `showModal()` gives the
 * Escape key, the focus move, the inert background and the top-layer stacking
 * for free, and this is a static export with no room for a modal library. The
 * element is always in the tree so the ref is stable; an effect opens and
 * closes it as the selection changes.
 */
function Browser({
  runs,
  at,
  onPick,
  onClose,
}: {
  runs: readonly TranscriptRun[];
  at: number | null;
  onPick: (index: number) => void;
  onClose: () => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const target = at === null ? null : (runs[at] ?? null);
  const correct = runs.filter(({ run }) => run.correct).length;

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
      className="bench-browser"
      aria-label="All transcripts"
      onClose={onClose}
      // A click that lands on the dialog itself rather than on its content is a
      // click on the backdrop, and the expected way out of a modal.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {target ? (
        <div className="bench-browser-panel">
          <div className="bench-browser-bar label">
            <span>All transcripts</span>
            <button type="button" className="bench-browser-close" onClick={onClose}>
              Close <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className="bench-browser-body">
            <div className="bench-browser-list">
              <p className="bench-browser-count label label-sm">
                {runs.length} runs · {correct} correct · {runs.length - correct} wrong
              </p>
              {runs.map((one, index) => (
                <button
                  type="button"
                  key={runKey(one)}
                  className={
                    index === at ? 'bench-browser-item bench-browser-item-on' : 'bench-browser-item'
                  }
                  aria-current={index === at ? 'true' : undefined}
                  onClick={() => onPick(index)}
                >
                  <span className="bench-browser-item-meta label label-sm">
                    <span>{one.question.id}</span>
                    <span>{one.question.category}</span>
                    <Verdict correct={one.run.correct} />
                  </span>
                  <code className={isProduct(one.run.adapter) ? 'bench-ours' : undefined}>
                    {adapterLabel(one.run.adapter)}
                  </code>
                  <span className="bench-browser-item-sub">
                    {one.run.calls.length} call{one.run.calls.length === 1 ? '' : 's'} ·{' '}
                    {count(one.run.contextTokens)} tok
                  </span>
                </button>
              ))}
            </div>
            <div className="bench-browser-detail">
              <QuestionHead question={target.question} />
              <Trace run={target} adapter />
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** One run's trace: what it cost, the calls in order, and the answer against the gold. */
function Trace({
  run: { question, run },
  adapter,
}: {
  run: TranscriptRun;
  adapter?: boolean;
}): ReactNode {
  const ours = isProduct(run.adapter);
  const stats: readonly [string, ReactNode][] = [
    ...(adapter ? ([['Adapter', adapterLabel(run.adapter)]] as [string, ReactNode][]) : []),
    ['Calls', run.calls.length],
    ['Tokens read', count(run.contextTokens)],
    ['Wall time', formatMs(run.ms)],
    ...(adapter
      ? ([['Result', <Verdict key="v" correct={run.correct} />]] as [string, ReactNode][])
      : []),
  ];

  return (
    <div className="bench-trace">
      <dl className="bench-trace-stats label label-sm">
        {stats.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {run.calls.length === 0 ? (
        <p className="bench-caption">
          No tool calls — {adapterLabel(run.adapter)} answered from the prompt.
        </p>
      ) : (
        <ol className={ours ? 'bench-calls bench-calls-ours' : 'bench-calls'}>
          {run.calls.map((call, index) => (
            <li
              className={call.failed ? 'bench-call bench-call-failed' : 'bench-call'}
              // biome-ignore lint/suspicious/noArrayIndexKey: the transcript is ordered and immutable — position in the call list is the identity of a call, and nothing is inserted, removed or reordered.
              key={index}
            >
              <div className="bench-call-head">
                <span className="bench-call-idx">{String(index + 1).padStart(2, '0')}</span>
                {call.failed ? <span className="bench-call-pill">failed</span> : null}
                <span className="bench-call-name">{call.name}</span>
                <span className="bench-call-ms">{formatMs(call.ms)}</span>
              </div>
              <pre className="bench-call-io">
                <code>{formatInput(call.input)}</code>
              </pre>
              <pre className="bench-call-io bench-call-out">
                <code>
                  <span aria-hidden="true">→ </span>
                  {call.output}
                </code>
              </pre>
            </li>
          ))}
        </ol>
      )}

      <div className="bench-trace-foot">
        <div>
          <div className="label label-sm">Answered</div>
          <p
            className={run.correct ? 'bench-trace-answer' : 'bench-trace-answer bench-trace-wrong'}
          >
            {summariseAnswer(run.answer)}
          </p>
        </div>
        <div>
          <div className="label label-sm">Expected</div>
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
