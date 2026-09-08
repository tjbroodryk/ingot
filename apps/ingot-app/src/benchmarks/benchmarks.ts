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
  readonly questions: number;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
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
  readonly byCategory: Readonly<Record<string, number>>;
}

export interface PublishedBenchmark {
  readonly schema: number;
  readonly generatedAt: string | null;
  readonly run: PublishedRun | null;
  readonly categories: readonly string[];
  readonly adapters: readonly PublishedAdapter[];
}

export const BENCHMARK = results as PublishedBenchmark;

/** The controls, which are reference points rather than entrants. */
export const CONTROL_NAMES: ReadonlySet<string> = new Set(['raw-context', 'oracle']);

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

export function leadStats(): readonly LeadStat[] {
  const memories = BENCHMARK.adapters.filter((a) => !CONTROL_NAMES.has(a.name));
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
export const HAS_RESULTS = BENCHMARK.run !== null && BENCHMARK.adapters.length > 0;

export const BENCHMARKS_DESCRIPTION =
  'What an agent gets back out of a memory, and what it costs to get it — Ingot ' +
  'against vector search local and hosted, a hosted memory, and its own embedding ' +
  'path with SQL taken away.';

export const BENCHMARKS_LEDE =
  'Ingot contains a vector index. So the question is not whether structure beats ' +
  'embeddings — it is whether typed rows and SQL on top of the same embeddings ' +
  'retrieve better than the embeddings alone, and what each answer costs in context.';

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
      'The same server and the same rows, over the REST API, with the tools written in this repository in the same voice as the baselines’. The gap to `ingot-mcp` is how much of the result is the surface rather than the data model.',
  },
  {
    name: 'ingot-mcp-text-search-only',
    blurb:
      'The ablation, and the most important column. The same store, the same rows and the same vectors, reachable only through top-k semantic search.',
  },
  {
    name: 'vector',
    blurb:
      'The shape of every “just put it in a vector store” answer: embed, rank by cosine, return top-k. It is chunked one document per record, so nothing is split mid-object and no chunk mixes two records — the friendliest chunking available, given deliberately. Same embedding model as Ingot, and brute-force exact cosine rather than an approximate index, so what it cannot do is a property of top-k retrieval and not of a weak baseline.',
  },
  {
    name: 'pinecone',
    blurb:
      'The hosted vector database, given the identical embeddings, chunking and search tool as `vector`. It is here to answer the objection that a baseline written in this repository is a strawman: if a production ANN index cannot beat brute-force cosine over the same vectors, what the top-k rows cannot do belongs to top-k retrieval and not to the baseline. Pinecone’s own embedding models are deliberately not used — one embedder across the table is the rule.',
  },
  {
    name: 'turbopuffer',
    blurb:
      'The same vectors again, in a hosted index built on object storage. Its full-text index is off: switching it on would make this row a hybrid search while the other two stay dense-only, and hybrid retrieval deserves its own column rather than a silent edge in this one.',
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
  {
    name: 'oracle',
    blurb:
      'Perfect retrieval: exactly the answer-bearing records and nothing else. The gap to an adapter is retrieval; the gap to 100% is the model.',
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
export const ADAPTERS: readonly { readonly name: string; readonly blurb: string }[] =
  BENCHMARK.adapters.length > 0
    ? ADAPTER_BLURBS.filter((blurb) =>
        BENCHMARK.adapters.some((adapter) => adapter.name === blurb.name),
      )
    : ADAPTER_BLURBS;

/** What each question category is for. The categories are the whole design. */
export const CATEGORIES: readonly { readonly name: string; readonly blurb: string }[] = [
  { name: 'aggregate', blurb: 'A statistic over the whole corpus, not a lookup.' },
  { name: 'absence', blurb: 'The answer is defined by what is missing. There is no text to be similar to.' },
  { name: 'ordering', blurb: 'Requires a total order, not a neighbourhood.' },
  { name: 'join', blurb: 'Two record types and a predicate across them.' },
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
      'A seeded generator builds a world; the corpus is that world rendered as the paginated tool results an agent would have received; the gold answers are computed from the world objects directly. That is what makes hundreds of questions affordable and every run reproducible from a seed — and it is also why this is a benchmark of a shape of workload rather than of anyone’s production traffic.',
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
      'Ingot asks for a column mapping up front; a vector store does not. Ingestion is timed but that asymmetry is real and this page does not put a number on it.',
  },
  {
    title: 'One corpus, one size',
    body:
      'The default world is around five hundred records — small enough that raw-context is a usable ceiling, which is the point of including it. Conclusions about a corpus a thousand times larger are not supported by this.',
  },
];
