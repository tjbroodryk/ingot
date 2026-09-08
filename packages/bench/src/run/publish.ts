import { buildCorpus, type ToolResult } from '../corpus/stream.js';
import { buildWorld } from '../corpus/world.js';
import type { Category } from '../questions/questions.js';
import { summarise, type ReportHeader, type RunRecord } from './report.js';

/**
 * The shape the site renders.
 *
 * A *summary*, deliberately: aggregates and provenance, never the transcripts.
 * Those are the expensive, private half of a run — they carry every tool call
 * and every returned row — and a published page needs none of it.
 *
 * The whole point of writing this file from the run rather than by hand is
 * that the page cannot drift from the data. A number on `/benchmarks` that
 * nobody can trace to a seed and a model is marketing, and this file is what
 * makes the difference: it carries what produced it alongside what it found.
 */
export interface PublishedBenchmark {
  /** The version of this file's own shape, so the page can refuse a stale one. */
  readonly schema: 1;
  readonly generatedAt: string | null;
  readonly run: PublishedRun | null;
  /** What the agents were given to remember. See {@link PublishedCorpus}. */
  readonly corpus: PublishedCorpus | null;
  readonly categories: readonly Category[];
  readonly adapters: readonly PublishedAdapter[];
}

/**
 * The workload, described rather than asserted.
 *
 * "Is this better than a vector store" is unanswerable without "over what",
 * and the answer here is specific: not documents, not prose, but the payloads
 * an agent's tool calls hand back — paginated JSON listings, and at `--logs N`
 * one unpaginated flood. A reader who does not know that is reading the table
 * as a claim about their own corpus, which it is not.
 *
 * Computed from the seed rather than written down, for the same reason every
 * other number on the page is: the world and the corpus are pure functions of
 * `--seed`, so this block is as reproducible as the accuracies beside it and
 * cannot drift from the fixture once somebody edits the generator.
 */
export interface PublishedCorpus {
  /** Tool results — payloads that arrived in the conversation. */
  readonly results: number;
  readonly records: number;
  /** Characters of JSON, which is what the context window actually spends. */
  readonly bytes: number;
  readonly sources: readonly PublishedSource[];
}

export interface PublishedSource {
  /** The tool that produced it: `github.list_pull_requests`. */
  readonly tool: string;
  readonly results: number;
  readonly records: number;
  /** Records in the fullest single payload — the page size the API imitates. */
  readonly perResult: number;
  /** False for a tool that hands everything back at once. */
  readonly paginated: boolean;
  readonly bytes: number;
  /** The largest single payload, which is what arrives in one message. */
  readonly largest: number;
  /** One record, verbatim, exactly as the agent received it. */
  readonly sample: string;
}

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
  /**
   * Log lines in the corpus, as one unpaginated result. 0 is the ordinary run.
   *
   * Published because it is the flag that decides which experiment this is: at
   * any interesting value the corpus stops fitting in a context window and
   * `raw-context` is refused rather than scored, so a page that did not say
   * which kind of run it was showing would be putting two of them under one
   * heading.
   */
  readonly logs: number;
  readonly questions: number;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export interface PublishedAdapter {
  readonly name: string;
  readonly runs: number;
  readonly accuracy: number;
  /** Binomial standard error; see the note in `report.ts`. */
  readonly stderr: number;
  readonly f1: number;
  readonly evidenceRecall: number | null;
  readonly evidencePrecision: number | null;
  readonly toolCalls: number;
  readonly contextTokens: number;
  /** Accuracy per category; a category with no questions is absent. */
  readonly byCategory: Readonly<Record<string, number>>;
}

/** The state the site ships with until a run has been published into it. */
export const NO_RESULTS: PublishedBenchmark = {
  schema: 1,
  generatedAt: null,
  run: null,
  corpus: null,
  categories: [],
  adapters: [],
};

/** What a paginated payload looks like from the outside. */
interface Page {
  readonly items?: readonly Record<string, unknown>[];
}

/**
 * The corpus this run's seed produces, measured.
 *
 * Rebuilt here rather than threaded through the run because it is free and
 * exact: `buildWorld` and `buildCorpus` are pure functions of the seed, so
 * this is the identical array of payloads every adapter ingested, down to the
 * bytes. Replaying an old run with `--from` therefore republishes the corpus
 * it was actually asked about.
 */
export function corpusShape(seed: number, logs: number): PublishedCorpus {
  const corpus = buildCorpus(buildWorld({ seed, logs }));

  // Grouped in the order the tools first appear, which is the order an agent
  // met them: a table sorted by size would put the shape of the corpus second
  // to the arithmetic of it.
  const order: string[] = [];
  const grouped = new Map<string, ToolResult[]>();
  for (const result of corpus) {
    const bucket = grouped.get(result.tool);
    if (bucket) bucket.push(result);
    else {
      order.push(result.tool);
      grouped.set(result.tool, [result]);
    }
  }

  const sources = order.map((tool): PublishedSource => {
    const results = grouped.get(tool) as ToolResult[];
    const items = results.map((result) => (result.result as Page).items ?? []);
    // What the payload weighs as it arrives, not what the world object weighs:
    // the corpus is a lossy view of the world and the lossy view is the thing
    // that costs context.
    const sizes = results.map((result) => JSON.stringify(result.result).length);
    const sum = (values: readonly number[]): number => values.reduce((total, n) => total + n, 0);
    const first = items[0]?.[0];

    return {
      tool,
      results: results.length,
      records: sum(items.map((page) => page.length)),
      perResult: Math.max(...items.map((page) => page.length)),
      // Only `logs.search` says so, and saying so is the whole point of it.
      paginated: (results[0] as ToolResult).args.paginated !== false,
      bytes: sum(sizes),
      largest: Math.max(...sizes),
      sample: first ? JSON.stringify(first, null, 2) : '',
    };
  });

  return {
    results: corpus.length,
    records: sources.reduce((total, source) => total + source.records, 0),
    bytes: sources.reduce((total, source) => total + source.bytes, 0),
    sources,
  };
}

export function publishable(
  header: ReportHeader,
  rows: readonly RunRecord[],
  categories: readonly Category[],
): PublishedBenchmark {
  const names = [...new Set(rows.map((row) => row.adapter))];

  const adapters = names.map((name): PublishedAdapter => {
    const mine = rows.filter((row) => row.adapter === name);
    const overall = summarise(mine);

    const byCategory: Record<string, number> = {};
    for (const category of categories) {
      const subset = mine.filter((row) => row.category === category);
      if (subset.length > 0) byCategory[category] = summarise(subset).accuracy;
    }

    return {
      name,
      runs: overall.n,
      accuracy: overall.accuracy,
      stderr: overall.stderr,
      f1: overall.f1,
      evidenceRecall: overall.evidenceRecall,
      evidencePrecision: overall.evidencePrecision,
      toolCalls: overall.toolCalls,
      contextTokens: Math.round(overall.finalInputTokens),
      byCategory,
    };
  });

  const questionIds = new Set(rows.map((row) => row.questionId));
  const categoryCounts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.questionId)) continue;
    seen.add(row.questionId);
    categoryCounts[row.category] = (categoryCounts[row.category] ?? 0) + 1;
  }

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    run: {
      runId: header.runId,
      seed: header.seed,
      provider: header.provider,
      model: header.model,
      effort: header.effort,
      thinking: header.thinking,
      repeats: header.repeats,
      maxToolCalls: header.maxToolCalls,
      embedder: header.embedder,
      mapping: header.mapping,
      logs: header.logs,
      questions: questionIds.size,
      categoryCounts,
      warnings: header.warnings,
    },
    corpus: corpusShape(header.seed, header.logs),
    // Only the categories this run actually asked about, so the page never
    // renders a column with nothing under it.
    categories: categories.filter((category) => categoryCounts[category] !== undefined),
    adapters,
  };
}
