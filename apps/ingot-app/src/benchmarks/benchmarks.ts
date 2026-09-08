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

/** Whether there is anything to show, which decides which page this is. */
export const HAS_RESULTS = BENCHMARK.run !== null && BENCHMARK.adapters.length > 0;

export const BENCHMARKS_DESCRIPTION =
  'What an agent gets back out of a memory, and what it costs to get it — Ingot ' +
  'against a vector baseline, a hosted memory, and its own embedding path with SQL taken away.';

export const BENCHMARKS_LEDE =
  'Ingot contains a vector index. So the question is not whether structure beats ' +
  'embeddings — it is whether typed rows and SQL on top of the same embeddings ' +
  'retrieve better than the embeddings alone, and what each answer costs in context.';

/** What each adapter in the table is, in the order the table shows them. */
export const ADAPTERS: readonly { readonly name: string; readonly blurb: string }[] = [
  {
    name: 'ingot',
    blurb:
      'The read surface a real agent gets over MCP: the schema at connect time, SQL, and ranking by meaning.',
  },
  {
    name: 'ingot-text-search-only',
    blurb:
      'The ablation, and the most important column. The same store, the same rows and the same vectors, reachable only through top-k semantic search.',
  },
  {
    name: 'vector',
    blurb:
      'Embed every record, rank by cosine, return top-k. The shape of every “just put it in a vector store” answer, given the same embedding model.',
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
