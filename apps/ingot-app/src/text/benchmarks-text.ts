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
  arrival,
  BENCHMARK,
  BENCHMARKS_DESCRIPTION,
  BENCHMARKS_LEDE,
  CATEGORIES,
  CORPUS_LEDE,
  HAS_RESULTS,
  LIMITS,
  mappingWriter,
  SOURCE_BLURBS,
  SOURCES,
} from '../benchmarks/benchmarks';
import { sourceHref } from '../site/mode';
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

    ...corpus(),

    heading(2, 'What is compared'),
    'One agent loop serves every column, with the same model, the same tool-call budget and the same answer channel. Only the retrieval tools differ, so a gap between two columns has exactly one possible cause.',
    table(
      ['Adapter', 'What it is'],
      ADAPTERS.map((adapter) => [`\`${adapter.name}\``, adapter.blurb]),
    ),

    heading(2, 'The questions'),
    'The split by category is the whole point of the benchmark. The claim under test is that SQL over typed rows, on top of ranking by meaning, recalls more of the answer than similarity search alone. Each category is somewhere that claim can fail. `aggregate`, `absence`, `ordering` and `join` are where structure should tell; `semantic` is where embeddings should. Report one number and you have averaged all of that away.',
    table(
      ['Category', 'What it asks'],
      CATEGORIES.map((category) => [`\`${category.name}\``, category.blurb]),
    ),

    heading(2, 'What this does not measure'),
    'We are publishing a benchmark of our own software, which you should discount accordingly. The least we can do is say plainly where it is weak, so here is everything we know is wrong with it.',
    ...LIMITS.flatMap((limit) => [heading(3, limit.title), limit.body]),

    heading(2, 'Check it'),
    'This is worth exactly as much as your ability to go and check it, so every part of it is one file. If you want to know whether we shaped the questions to flatter ourselves, read the generator — do not take our word for it.',
    table(
      ['Question', 'Where'],
      SOURCES.map((source) => [source.question, `[\`${source.path}\`](${sourceHref(source.path)})`]),
    ),
    '`bun run bench --dry-run` prints every question and every gold answer without making a single API call.',
  )}\n`;
}

/**
 * What the memories were asked to hold.
 *
 * The section that matters most in this half of the page. An assistant asked
 * "is Ingot better than a vector store" will answer from these words, and the
 * honest answer is conditional on a workload — tool-call JSON, paginated, most
 * of it never read again. Quoting the accuracy without the corpus it was
 * measured over is the same failure as quoting it without the model.
 */
function corpus(): readonly string[] {
  const shape = BENCHMARK.corpus;
  const count = (value: number): string => value.toLocaleString('en-GB');

  const described = shape
    ? shape.sources.map((source) => ({
        source,
        blurb: SOURCE_BLURBS.find((entry) => entry.tool === source.tool),
      }))
    : SOURCE_BLURBS.map((blurb) => ({ source: null, blurb }));

  return [
    heading(2, 'What it is asked about'),
    CORPUS_LEDE,
    ...(shape
      ? [
          bullets([
            `${count(shape.results)} tool results, ${count(shape.records)} records, ${count(shape.bytes)} characters of JSON.`,
            'Rebuilt from the run’s seed at publish time, so this is the array of payloads every adapter ingested rather than a description of it.',
          ]),
          table(
            ['Source', 'Shape', 'What arrives'],
            described.map(({ source, blurb }) => [
              `\`${source?.tool ?? blurb?.tool ?? ''}\``,
              blurb?.shape ?? '',
              source === null ? '—' : arrival(source),
            ]),
          ),
        ]
      : []),
    ...described.flatMap(({ source, blurb }) => [
      heading(3, `\`${source?.tool ?? blurb?.tool ?? ''}\``),
      blurb?.blurb ?? '',
      // One record verbatim. A model answering from this page should be able
      // to say what the data looked like, not only how much of it there was.
      ...(source?.sample ? [fence(source.sample)] : []),
    ]),
  ];
}

/** The numbers, or an honest statement that there are none yet. */
function results(): readonly string[] {
  const { run, categories, adapters } = BENCHMARK;

  if (!HAS_RESULTS || !run) {
    return [
      heading(2, 'Results'),
      'No run has been published yet. The harness is in `packages/bench`; the method below is what it does, and this section fills in when a run is published into it:',
      fence('bun run bench --publish ../../apps/ingot-app/src/benchmarks/results.json'),
    ];
  }

  return [
    heading(2, 'Results'),
    bullets([
      `Seed \`${run.seed}\`, ${run.questions} questions, ${run.repeats} run(s) each.`,
      `Agent: \`${run.model}\` on \`${run.provider}\`, reasoning ${run.thinking ? `\`${run.effort}\`` : 'off'}.`,
      `Embedder: \`${run.embedder}\`. Ingot's column mappings: ${mappingWriter(run.mapping)}.`,
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
    // Named here as well as on the page: an assistant quoting a column that
    // lost a fifth of its runs to a rate limit should be able to say so.
    ...(adapters.some((adapter) => adapter.failures > 0)
      ? [
          `Runs that failed outright — the provider threw and nothing was answered: ${adapters
            .filter((adapter) => adapter.failures > 0)
            .map((adapter) => `\`${adapter.name}\` ${adapter.failures} of ${adapter.runs}`)
            .join(
              ', ',
            )}. They are scored wrong, but they are infrastructure failures rather than retrieval failures.`,
        ]
      : []),
  ];
}
