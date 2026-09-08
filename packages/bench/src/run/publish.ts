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
  readonly categories: readonly Category[];
  readonly adapters: readonly PublishedAdapter[];
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
  categories: [],
  adapters: [],
};

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
      questions: questionIds.size,
      categoryCounts,
      warnings: header.warnings,
    },
    // Only the categories this run actually asked about, so the page never
    // renders a column with nothing under it.
    categories: categories.filter((category) => categoryCounts[category] !== undefined),
    adapters,
  };
}
