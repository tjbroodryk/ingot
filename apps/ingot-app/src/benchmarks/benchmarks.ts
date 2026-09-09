import type { Metadata } from 'next';
import results from './results.json';

/**
 * The published benchmark, and the words around it.
 *
 * The numbers are not in this file and never should be. `results.json` is
 * written by `packages/bench` from a real run — `bun run bench --publish` —
 * and everything the page renders comes from there, so a figure on this page
 * cannot be typed by somebody who wanted it to be higher. What lives here is
 * the prose that does not change between runs: what each column means, and
 * what the measurement does not cover.
 *
 * The shape is a contract between two artefacts, the way `@ingot/shared` is
 * one between the service and its callers. `packages/bench/src/run/publish.ts`
 * is the producer; `test/benchmarks.test.tsx` asserts the file on disk still
 * satisfies it.
 */

export interface PublishedRun {
  readonly runId: string;
  readonly seed: number;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly thinking: boolean;
  readonly repeats: number;
  readonly maxToolCalls: number;
  readonly embedder: string;
  readonly mapping: string;
  /** Log lines in the corpus, as one unpaginated result. 0 is the ordinary run. */
  readonly logs: number;
  /**
   * Whether the corpus was rendered with a payload shape that changes
   * underneath the agent. False is the ordinary run.
   *
   * Read by the page for the same reason `logs` is: the two runs answer the
   * same questions over different corpora, and a drifted run rendered as an
   * ordinary one would understate every column in the table.
   */
  readonly drift: boolean;
  readonly questions: number;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

/** What the agents were given to remember, measured from the seed. */
export interface PublishedCorpus {
  readonly results: number;
  readonly records: number;
  readonly bytes: number;
  readonly sources: readonly PublishedSource[];
}

export interface PublishedSource {
  readonly tool: string;
  readonly results: number;
  readonly records: number;
  readonly perResult: number;
  readonly paginated: boolean;
  readonly bytes: number;
  readonly largest: number;
  readonly sample: string;
}

export interface PublishedAdapter {
  readonly name: string;
  readonly runs: number;
  readonly accuracy: number;
  readonly stderr: number;
  readonly f1: number;
  readonly evidenceRecall: number | null;
  readonly evidencePrecision: number | null;
  readonly toolCalls: number;
  readonly contextTokens: number;
  /** Runs where the provider threw and nothing was answered. Scored wrong. */
  readonly failures: number;
  readonly byCategory: Readonly<Record<string, number>>;
}

export interface PublishedBenchmark {
  readonly schema: number;
  readonly generatedAt: string | null;
  /**
   * One table per corpus the questions were asked over, ordinary first.
   *
   * A list because `--drift` made the corpus a variable. The same columns over
   * an ordinary corpus and over one whose payloads change shape are two
   * tables and never two sets of columns in one — the harness refuses that
   * merge — but they belong on the same page, because a reader shown only the
   * ordinary table is being shown the friendliest case this project can
   * construct.
   */
  readonly tables: readonly PublishedTable[];
}

export interface PublishedTable {
  /** What this table is, for the switch that selects it: `drifted`. */
  readonly label: string;
  readonly run: PublishedRun;
  readonly corpus: PublishedCorpus;
  readonly categories: readonly string[];
  readonly adapters: readonly PublishedAdapter[];
}

export const BENCHMARK = results as PublishedBenchmark;

/** Every published run, in the order the page offers them. */
export const TABLES: readonly PublishedTable[] = BENCHMARK.tables ?? [];

/**
 * The transcripts, fetched at runtime rather than imported.
 *
 * `results.json` above is imported and therefore bundled; the transcripts are
 * the expensive half — every returned row of every tool call — and importing
 * them would put tens of megabytes into the landing page's JS for a section
 * most readers never open. So they are a static file the page fetches only when
 * a reader asks to see what an adapter did. `packages/bench` writes it into
 * `public/` alongside `results.json`, in the same per-table, merge-safe shape,
 * mirrored here as the read contract — the producer is
 * `packages/bench/src/run/publish.ts`.
 */
export interface PublishedTranscripts {
  readonly schema: number;
  readonly generatedAt: string | null;
  readonly tables: readonly TranscriptTable[];
}

/** One corpus's transcripts, keyed by the same label as its {@link PublishedTable}. */
export interface TranscriptTable {
  readonly label: string;
  readonly questions: readonly TranscriptQuestion[];
}

export interface TranscriptQuestion {
  readonly id: string;
  readonly question: string;
  readonly category: string;
  /** The gold answer, so a reader can check each column against it in place. */
  readonly gold: unknown;
  readonly adapters: readonly AdapterTranscript[];
}

export interface AdapterTranscript {
  readonly adapter: string;
  readonly answer: unknown;
  readonly correct: boolean;
  readonly calls: readonly PublishedCall[];
}

export interface PublishedCall {
  readonly name: string;
  /** The tool input, verbatim: the SQL, the search query, the arguments. */
  readonly input: Record<string, unknown>;
  /** What the tool returned, capped by the harness with the truncation marked. */
  readonly output: string;
  readonly failed: boolean;
}

/**
 * The sidecar's name under `public/`. Fetched through `BASE_PATH`, never
 * imported — the whole reason it is a separate file.
 */
export const TRANSCRIPTS_FILE = 'benchmark-transcripts.json';

/**
 * The control, which is a reference point rather than an entrant.
 *
 * `oracle` was the other one. It placed exactly the answer-bearing records in
 * the prompt and was described as perfect retrieval, which it was not: it got
 * the records that *constitute* an answer and never the ones that establish
 * why they are the answer, so on a question whose predicate spans two record
 * types it was asked to assert what its prompt could not support, and it
 * answered nothing. A ceiling that sits below the columns it is meant to bound
 * is worse than no ceiling — a reader takes the gap for a finding. This one
 * bounds the model with strictly more information and needs no caveat.
 */
export const CONTROL_NAMES: ReadonlySet<string> = new Set(['raw-context']);

/**
 * The three figures worth putting at the top, computed rather than chosen.
 *
 * Every one is a fact with a name attached: which adapter, how much, of what.
 * The temptation with a lead like this is a headline claim — "structured
 * memory wins" — and the reason not to is that a benchmark published by the
 * thing it measures has to be readable by somebody who assumes it is
 * marketing. Facts survive that reading; a verdict does not, and a verdict
 * these error bars cannot support survives it least of all.
 */
export interface LeadStat {
  readonly value: string;
  readonly label: string;
  /**
   * The adapters the figure is about, kept apart from the label so the page
   * can set them in the accent the way every other emphasis on this site is
   * set. A figure with no subject is the marketing version of itself, so the
   * subject is never folded into the prose.
   */
  readonly subjects: readonly string[];
}

export function leadStats(table: PublishedTable | null): readonly LeadStat[] {
  const memories = (table?.adapters ?? []).filter((a) => !CONTROL_NAMES.has(a.name));
  if (memories.length === 0) return [];

  const byAccuracy = [...memories].sort((a, b) => b.accuracy - a.accuracy);
  const byContext = [...memories].sort((a, b) => a.contextTokens - b.contextTokens);
  const best = byAccuracy[0] as PublishedAdapter;
  const leanest = byContext[0] as PublishedAdapter;
  const heaviest = byContext[byContext.length - 1] as PublishedAdapter;

  const stats: LeadStat[] = [
    {
      value: `${Math.round(best.accuracy * 100)}%`,
      label: 'highest overall accuracy',
      subjects: [best.name],
    },
    {
      value: leanest.contextTokens.toLocaleString('en-GB'),
      label: 'fewest context tokens per answer',
      subjects: [leanest.name],
    },
  ];

  // Only worth a tile when there is a spread to report.
  if (leanest.contextTokens > 0 && heaviest.contextTokens > leanest.contextTokens) {
    stats.push({
      value: `${(heaviest.contextTokens / leanest.contextTokens).toFixed(1)}×`,
      label: 'context-token spread, leanest to heaviest',
      subjects: [leanest.name, heaviest.name],
    });
  }
  return stats;
}

/** Whether there is anything to show, which decides which page this is. */
export const HAS_RESULTS = TABLES.some((table) => table.adapters.length > 0);

export const BENCHMARKS_DESCRIPTION =
  'What an agent gets back out of a memory, and what it costs to get it — Ingot ' +
  'against vector search local and hosted, a hosted memory, and its own embedding ' +
  'path with SQL taken away.';

/**
 * The route's metadata, kept here rather than beside the component.
 *
 * `benchmarks-page.tsx` is a client component, and every export of a client
 * module reaches a server component as a reference proxy rather than as the
 * value — so a `Metadata` object exported from there prerenders as `undefined`
 * and the build fails with an error that does not name the cause. This module
 * carries no directive and is read by the page, the text emitter and the route
 * alike, which makes it the right side of that boundary.
 */
export const benchmarksMetadata: Metadata = {
  title: 'Benchmarks',
  description: BENCHMARKS_DESCRIPTION,
};

export const BENCHMARKS_LEDE =
  'Ingot contains a vector index, so we are not going to pretend this is ' +
  'structure versus embeddings. The question we actually wanted answered is ' +
  'narrower: do typed rows and SQL on top of the same embeddings retrieve ' +
  'better than those embeddings alone, and what does each answer cost in context?';

/** What each adapter is, in the order the table shows them. */
const ADAPTER_BLURBS: readonly { readonly name: string; readonly blurb: string }[] = [
  {
    name: 'ingot-mcp',
    blurb:
      'The read surface a real agent gets over MCP: the schema at connect time, SQL, and ranking by meaning.',
  },
  {
    name: 'ingot-rest',
    blurb:
      'The same server and the same rows, over the REST API, with the tools written in this repository in the same voice as the baselines’. The gap to `ingot-mcp` tells you how much of the result is the surface and how much is the data model.',
  },
  {
    name: 'control-same-store-top-k',
    blurb:
      'The control, and the most important column on this page. It is the sceptic’s question, run rather than argued. Ingot contains a vector index, so a win over a vector store could be the structure — or it could be nothing more than a better chunker. This row holds the store constant and takes the structure away: same rows, same vectors, same server, reachable only through top-k semantic search. Whatever separates it from `ingot-mcp` is what SQL over typed rows is worth, and nothing else.',
  },
  {
    name: 'control-same-store-top-k-rest',
    blurb:
      'The same control over the REST surface, for when `ingot-rest` is in the table: the gap between the two says how much of the surface’s result survives without SQL.',
  },
  {
    name: 'vector',
    blurb:
      'The shape of every “just put it in a vector store” answer: embed, rank by cosine, return top-k. Chunked one document per record, so nothing is split mid-object and no chunk mixes two records — the friendliest chunking available, given deliberately. Same embedding model as Ingot, and brute-force exact cosine rather than an approximate index. What it cannot do is a property of top-k retrieval, not of a baseline built to lose.',
  },
  {
    name: 'pinecone',
    blurb:
      'The hosted vector database, given the identical embeddings, chunking and search tool as `vector`. It is here to answer the obvious objection that a baseline written in this repository is a strawman: if a production ANN index cannot beat brute-force cosine over the same vectors, then what the top-k rows cannot do belongs to top-k retrieval and not to the baseline. Pinecone’s own embedding models are deliberately not used — one embedder across the whole table is the rule.',
  },
  {
    name: 'turbopuffer',
    blurb:
      'The same vectors again, in a hosted index built on object storage. Its full-text index is off: switching it on would make this row a hybrid search while the other two stay dense-only, and hybrid retrieval deserves a column of its own rather than a silent edge in this one.',
  },
  {
    name: 'hyperspell',
    blurb: 'A hosted memory, configured as its own documentation says to configure it.',
  },
  {
    name: 'raw-context',
    blurb:
      'No retrieval at all — the whole corpus in the prompt. The ceiling for a memory that fits in the window, and the cost baseline everything else should undercut.',
  },
];

/**
 * The blurbs for the columns this published run actually has.
 *
 * The catalogue above outlives any one run: a column is described there as
 * soon as it exists in `packages/bench`, which is before the next run has been
 * bought. Describing a column the table does not show would be the page
 * claiming a comparison nobody has run — so the page renders the intersection,
 * and falls back to the whole catalogue only when there are no results at all
 * and it is explaining what it is going to measure rather than what it found.
 */
export const ADAPTERS: readonly { readonly name: string; readonly blurb: string }[] = HAS_RESULTS
  ? // The union across published runs, not the intersection. A column that ran
    // on the ordinary corpus and was skipped on the drifted one is still a
    // column this page shows, and describing it in one tab but not the other
    // would read as two different benchmarks rather than one under two corpora.
    ADAPTER_BLURBS.filter((blurb) =>
      TABLES.some((table) => table.adapters.some((adapter) => adapter.name === blurb.name)),
    )
  : ADAPTER_BLURBS;

/**
 * What the memories were asked to hold, said before the table is read.
 *
 * The commonest misreading of a benchmark like this one is to take it as a
 * claim about documents. It is not: nothing here is a wiki page or a PDF or a
 * support thread. It is an agent's tool traffic — the JSON that comes back
 * from a listing endpoint, thirty records at a time, in the middle of a
 * conversation about something else. That is the workload Ingot is for, and a
 * reader whose corpus is prose should know that before they read a number and
 * not after.
 */
export const CORPUS_LEDE =
  'Nothing in this corpus is a document. Every byte of it arrived the way an agent’s ' +
  'context actually fills up: as the JSON a tool call hands back — paginated listings ' +
  'from a code catalogue, a pull-request API, a CI service, a pager and an issue ' +
  'tracker, each one a blob with no schema attached, most of it never referred to ' +
  'again. Every adapter ingests the identical array of payloads, so what separates ' +
  'them is what they can do with the same bytes afterwards.';

/**
 * A small count as a word, for a heading that has to agree with the table.
 *
 * The section that compares the columns was headed "Six memories" — true when
 * it was written, false the moment `pinecone`, `turbopuffer` and `ingot-rest`
 * were added, and nobody noticed because a heading is not a number anybody
 * checks. On a page whose whole claim is that no figure in it was typed by
 * hand, a hand-typed count in 48pt is the worst place for one to rot, so the
 * heading counts the columns the run actually published.
 *
 * Words to twelve, digits after: "Fourteen columns" reads as prose that has
 * lost track of itself, and by then the number is the point anyway.
 */
export function countWord(value: number): string {
  const words = [
    'No',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
  ];
  return words[value] ?? String(value);
}

/**
 * Who wrote Ingot's column mappings, in words rather than as a flag's value.
 *
 * The run records `authored` or `agent`, and this page used to render it as
 * `${mapping}-written` — which reads correctly for one of the two values and
 * as "authored-written" for the other. The distinction is real and worth
 * saying plainly: `authored` is the hand-written schema a careful engineer
 * would produce knowing the shape of each tool's output, and `agent` is the
 * realistic case where the agent meets a payload for the first time and has to
 * invent the mapping. The gap between them is how much of Ingot's result
 * survives nobody tuning it by hand.
 */
export function mappingWriter(mapping: string): string {
  if (mapping === 'authored') return 'hand-written';
  if (mapping === 'agent') return 'agent-written';
  // A value this build has not met. Showing it beats claiming one of the two
  // above and being wrong about which.
  return mapping;
}

/**
 * How one source's payloads arrived, in a line.
 *
 * Shared by the page and the markdown half rather than written twice, because
 * the two would drift and the reading is the same either way. The cases are
 * genuinely different rather than a plural: a listing that fits in one payload
 * has no page size worth quoting, and the tool that does not paginate is the
 * one whose whole point is that everything came at once.
 */
export function arrival(source: PublishedSource): string {
  const count = (value: number): string => value.toLocaleString('en-GB');

  if (!source.paginated) {
    return `one unpaginated payload, ${count(source.records)} records, ${count(source.bytes)} characters in a single message`;
  }
  if (source.results === 1) {
    return `one payload, ${count(source.records)} records, ${count(source.bytes)} characters`;
  }
  return `${count(source.results)} payloads, ${source.perResult} records a page, ${count(source.records)} records, ${count(source.largest)} characters in the largest`;
}

/**
 * How the payloads connect, which is the part a reader has to be told.
 *
 * Every source above describes itself. None of them describes the others, and
 * there is no schema, no foreign key and no shared identifier scheme — the
 * only thing joining two results is a value in one that happens to equal a
 * value in the other. An agent has to notice that, and get it right, before a
 * question spanning two payloads can be answered at all.
 *
 * The last row is not a curiosity. A run of this benchmark had Ingot answer
 * "which services have had no incidents" with *all eight services*, because
 * the model joined `incidents.service` to `services.ref` — `catalog` against
 * `svc:catalog` — and matched nothing. Confidently, plausibly, and completely
 * wrong. Real tool payloads spell the same entity two ways all the time, and a
 * corpus that tidied it up would be modelling a friendlier world than the one
 * the agent works in.
 */
export const CORPUS_JOINS: readonly {
  readonly from: string;
  readonly to: string;
  readonly by: string;
}[] = [
  {
    from: 'github.list_pull_requests.files[]',
    to: 'catalog.list_files.path',
    by: 'a file path, as a bare string inside a nested array',
  },
  {
    from: 'ci.list_runs.pr',
    to: 'github.list_pull_requests.number',
    by: 'an integer that is a key in one payload and an ordinary field in the other',
  },
  {
    from: 'catalog.list_files.service',
    to: 'catalog.list_services.name',
    by: 'a service name — matching `name`, never the `ref` beside it',
  },
  {
    from: 'pagerduty.list_incidents.service',
    to: 'catalog.list_services.name',
    by: 'the same name again: `catalog`, where the service record answers to `svc:catalog`',
  },
];

/**
 * What each tool result is, and what shape it arrives in.
 *
 * The catalogue outlives any one run — `logs.search` is described here whether
 * or not the published run opted into it — and the page renders the
 * intersection with what was actually published, the same rule the adapter
 * blurbs follow.
 */
export const SOURCE_BLURBS: readonly {
  readonly tool: string;
  /** The shape, in the words somebody would use to describe it out loud. */
  readonly shape: string;
  readonly blurb: string;
}[] = [
  {
    tool: 'catalog.list_services',
    shape: 'One small JSON page',
    blurb:
      'A service catalogue, arriving whole. It is the only place ownership is recorded, and two of the services record it as `null` — present and empty, not missing. That makes the absence questions hard without making them unanswerable.',
  },
  {
    tool: 'catalog.list_files',
    shape: 'JSON pages of 40',
    blurb:
      'A repository listing: path, service, size. Nothing an embedding can tell apart — every record reads almost exactly like every other one, so a top-k over them is close to a coin flip.',
  },
  {
    tool: 'github.list_pull_requests',
    shape: 'JSON pages of 25, nested',
    blurb:
      'The largest payloads in the corpus, and the ones with structure inside the structure: each record carries an array of touched files and an array of labels. This is the blob an agent reads once, answers one question from, and drops.',
  },
  {
    tool: 'ci.list_runs',
    shape: 'JSON pages of 40',
    blurb:
      'The most repetitive source, and the biggest by record count: build after build, most of them green and uninteresting until a question is about the one that failed or the three that took longest.',
  },
  {
    tool: 'pagerduty.list_incidents',
    shape: 'JSON pages of 10, with prose',
    blurb:
      'Incidents, each with a written summary — a sentence of English inside a JSON field, which is where the cause of an outage actually lives. The semantic questions ask about these in words the summary never uses.',
  },
  {
    tool: 'linear.search_issues',
    shape: 'JSON pages of 20, with free text',
    blurb:
      'Issues: a title, a state, an assignee who is sometimes nobody, and a free-text body. The most document-like thing here, and still mostly fields.',
  },
  {
    tool: 'logs.search',
    shape: 'One unpaginated flood',
    blurb:
      'The other case entirely: a single search that comes back with tens of thousands of lines and does not fit in the window at all. Opt-in with `--logs N`, because it changes what the benchmark is — `raw-context` stops being a ceiling and starts being a refused request.',
  },
];

/** What each question category is for. The categories are the whole design. */
export const CATEGORIES: readonly { readonly name: string; readonly blurb: string }[] = [
  { name: 'aggregate', blurb: 'A statistic over the whole corpus, not a lookup.' },
  {
    name: 'absence',
    blurb:
      'The answer is defined by what is missing — a field left null, or a record with no counterpart in another tool result. There is no text to be similar to.',
  },
  { name: 'ordering', blurb: 'Requires a total order, not a neighbourhood.' },
  {
    name: 'join',
    blurb:
      'Records from two or three different tool results, joined on a value nobody declared as a key — a file path in one payload, a service name in another, the team that owns it in a third.',
  },
  {
    name: 'semantic',
    blurb:
      'Asked with a paraphrase that shares no distinctive term with the record. The category built to be hard for SQL and easy for embeddings.',
  },
  { name: 'multi-hop', blurb: 'Two hops and an argmax.' },
];

/**
 * Where to check each claim this page makes.
 *
 * A benchmark published by the thing it measures is worth exactly as much as
 * a reader's ability to go and look. Every load-bearing part of it is one
 * file, and each is named here by the question it answers rather than by what
 * it is — "where do the questions come from" is what somebody wants, not
 * `questions.ts`.
 */
export const SOURCES: readonly {
  readonly question: string;
  readonly path: string;
  readonly detail: string;
}[] = [
  {
    question: 'Where do the questions come from?',
    path: 'packages/bench/src/questions/questions.ts',
    detail:
      'Every question and every gold answer, computed from the generated world rather than annotated. Nothing here is written by hand.',
  },
  {
    question: 'What is the corpus?',
    path: 'packages/bench/src/corpus/world.ts',
    detail:
      'The seeded generator. `--seed` reproduces it exactly, and the tool results the adapters ingest are a lossy view of these objects.',
  },
  {
    question: 'What does the agent actually receive?',
    path: 'packages/bench/src/corpus/stream.ts',
    detail:
      'The world rendered as tool results: paginated JSON with no schema attached, at the page sizes the APIs it imitates use. Every adapter ingests this identical array, and the samples on this page are records out of it.',
  },
  {
    question: 'How is correctness decided?',
    path: 'packages/bench/src/score/score.ts',
    detail:
      'Counts exact, sets by F1, ordered lists in order. No model grades anything.',
  },
  {
    question: 'What does each memory get?',
    path: 'packages/bench/src/adapters',
    detail: 'One interface, ten implementations. The tools each adapter puts in front of the agent.',
  },
  {
    question: 'What does the agent do with them?',
    path: 'packages/bench/src/agent/loop.ts',
    detail:
      'One loop for every column: same model, same budget, same answer channel. Only the tool list differs.',
  },
];

/** The caveats, stated on the page rather than in a footnote nobody opens. */
export const LIMITS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'The questions are generated, not collected',
    body:
      'A seeded generator builds a world; the corpus is that world rendered as the paginated tool results an agent would have received; the gold answers are computed from the world objects directly. That is what makes hundreds of questions affordable and every run reproducible from a seed. It is also why this is a benchmark of a shape of workload, and not of anyone’s production traffic.',
  },
  {
    title: 'Evidence recall is not defined for every question',
    body:
      'Aggregate questions are scored on the answer alone. A correct count of thirty-seven pull requests is its own evidence, and demanding that thirty-seven records come back through the tools would score the cheapest correct path — one SELECT count(*) — as a total retrieval failure.',
  },
  {
    title: 'There is no model judging the answers',
    body:
      'Every category is machine-scorable by construction: counts, sets of record ids, ordered lists of record ids. A judge would be a second model whose mistakes land in the same column as the retrieval failures being measured.',
  },
  {
    title: 'Write cost is not scored',
    body:
      'Ingot asks for a column mapping up front and a vector store does not. Ingestion is timed, but that asymmetry is real and this page does not put a number on it.',
  },
  {
    title: 'There is one ceiling, and it has a size limit',
    body:
      '`raw-context` reads the whole corpus and answers from it, which makes it the upper bound on what this model does with complete information — but only for as long as the corpus fits in a context window. Above that the request is refused before inference, and a run at that size has no ceiling on the page at all. This one is around five hundred records, well inside the window, so the bound holds here. It would not for a memory a thousand times larger.',
  },
  {
    title: 'The generator moves faster than the runs',
    body:
      'Question templates get added to the harness as the workload it models gets better understood, so a published table is a snapshot of the set as it stood on its date. The run id, the seed and the date above pin exactly which questions were asked, and the generator is one link away. But a category is described here by what it is for, which may be broader than the sample any one run drew from it.',
  },
  {
    title: 'One corpus, one size',
    body:
      'The default world is around five hundred records — small enough that raw-context is a usable ceiling, which is the point of including it. Conclusions about a corpus a thousand times larger are not supported by this.',
  },
];
