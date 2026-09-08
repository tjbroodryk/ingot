/**
 * `/benchmarks`, as markdown. See `./reference-text.ts` for why.
 *
 * This page matters more in plain text than most: "is it actually better than
 * a vector store" is a question asked of an assistant far more often than it
 * is asked of a website, and the answer a model gives should be the one this
 * project can defend rather than a paraphrase of the landing copy.
 *
 * So the numbers come from the same `results.json` the page renders, and the
 * limits are written out in full rather than summarised — an index entry that
 * quoted the headline figure without the conditions on it would be the exact
 * failure the page is built to avoid.
 */

import {
  ADAPTERS,
  BENCHMARK,
  BENCHMARKS_DESCRIPTION,
  BENCHMARKS_LEDE,
  CATEGORIES,
  HAS_RESULTS,
  LIMITS,
} from '../benchmarks/benchmarks';
import type { Article } from './markdown';
import { blocks, bullets, fence, heading, table } from './markdown';

export const BENCHMARKS: Article = {
  title: 'Benchmarks',
  summary: BENCHMARKS_DESCRIPTION,
  render: renderBenchmarks,
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function renderBenchmarks(): string {
  return `${blocks(
    heading(1, 'What comes back out'),
    `> ${BENCHMARKS_DESCRIPTION}`,
    BENCHMARKS_LEDE,

    ...results(),

    heading(2, 'What is compared'),
    'One agent loop serves every column, with the same model, the same tool-call budget and the same answer channel. Only the retrieval tools differ, so a gap between two columns has one possible cause.',
    table(
      ['Adapter', 'What it is'],
      ADAPTERS.map((adapter) => [`\`${adapter.name}\``, adapter.blurb]),
    ),

    heading(2, 'The questions'),
    'The categories are the design. Similarity search cannot aggregate, cannot express absence and cannot order — and it does well on meaning. A single number would be hiding which of those it was made of.',
    table(
      ['Category', 'What it asks'],
      CATEGORIES.map((category) => [`\`${category.name}\``, category.blurb]),
    ),

    heading(2, 'What this does not measure'),
    'A benchmark published by the thing it measures has one obligation above the rest: say plainly where it is weak.',
    ...LIMITS.flatMap((limit) => [heading(3, limit.title), limit.body]),
  )}\n`;
}

/** The numbers, or an honest statement that there are none yet. */
function results(): readonly string[] {
  const { run, categories, adapters } = BENCHMARK;

  if (!HAS_RESULTS || !run) {
    return [
      heading(2, 'Results'),
      'No run has been published yet. The harness is in `packages/bench`; the method below is what it does, and this section fills in when a run is published into it:',
      fence('bun run bench --publish ../../apps/ingot-app/src/benchmarks/results.json'),
      'Nothing on this page is written by hand, so there are no numbers until there has been a run to produce them.',
    ];
  }

  return [
    heading(2, 'Results'),
    bullets([
      `Seed \`${run.seed}\`, ${run.questions} questions, ${run.repeats} run(s) each.`,
      `Agent: \`${run.model}\` on \`${run.provider}\`, reasoning ${run.thinking ? `\`${run.effort}\`` : 'off'}.`,
      `Embedder: \`${run.embedder}\`. Ingot schema: ${run.mapping}-written.`,
      `Retrieval budget: ${run.maxToolCalls} tool calls per question.`,
      `Run \`${run.runId}\`${BENCHMARK.generatedAt ? `, published ${BENCHMARK.generatedAt.slice(0, 10)}` : ''}.`,
    ]),
    ...run.warnings.map((warning) => `**${warning}**`),

    heading(3, 'Accuracy by category'),
    table(
      ['Adapter', 'Overall', ...categories],
      adapters.map((adapter) => [
        `\`${adapter.name}\``,
        `${percent(adapter.accuracy)} ±${percent(adapter.stderr)}`,
        ...categories.map((category) =>
          adapter.byCategory[category] === undefined
            ? '—'
            : percent(adapter.byCategory[category] as number),
        ),
      ]),
    ),

    heading(3, 'Retrieval and cost'),
    table(
      ['Adapter', 'Set F1', 'Evidence recall', 'Evidence precision', 'Tool calls', 'Context tokens'],
      adapters.map((adapter) => [
        `\`${adapter.name}\``,
        adapter.f1.toFixed(2),
        adapter.evidenceRecall === null ? '—' : percent(adapter.evidenceRecall),
        adapter.evidencePrecision === null ? '—' : percent(adapter.evidencePrecision),
        adapter.toolCalls.toFixed(1),
        String(adapter.contextTokens),
      ]),
    ),
    'Evidence recall is the share of the answer-bearing records that came back through the tools; precision is the share of what came back that was answer-bearing. Both are computed only over questions whose answer is a set of records — an aggregate answer is a statistic, and a correct count is its own evidence.',
  ];
}
