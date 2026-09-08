import type { ToolCallRecord } from '../agent/loop.js';
import type { Category, Gold } from '../questions/questions.js';

/**
 * One row per (adapter, question, repeat). Written as JSONL so a scoring
 * change can be replayed over an existing run instead of buying it again —
 * the transcripts are the expensive part and they are all here.
 */
export interface RunRecord {
  readonly runId: string;
  readonly adapter: string;
  readonly questionId: string;
  readonly category: Category;
  readonly repeat: number;
  readonly question: string;
  readonly gold: Gold;
  readonly answer: unknown;
  readonly submitted: boolean;
  readonly stopReason: string | null;
  readonly correct: boolean;
  readonly f1: number;
  readonly evidenceRecall: number | null;
  readonly evidencePrecision: number | null;
  readonly toolCalls: number;
  readonly failedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly finalInputTokens: number;
  readonly ms: number;
  readonly calls: readonly ToolCallRecord[];
}

export interface Cell {
  readonly n: number;
  readonly accuracy: number;
  readonly f1: number;
  readonly evidenceRecall: number | null;
  readonly evidencePrecision: number | null;
  readonly finalInputTokens: number;
  readonly toolCalls: number;
  /** Standard error of the accuracy, for the ± in the table. */
  readonly stderr: number;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarise(rows: readonly RunRecord[]): Cell {
  const accuracies = rows.map((row) => (row.correct ? 1 : 0));
  const accuracy = mean(accuracies);
  const defined = <T>(values: readonly (T | null)[]): T[] =>
    values.filter((value): value is T => value !== null);
  const recalls = defined(rows.map((row) => row.evidenceRecall));
  const precisions = defined(rows.map((row) => row.evidencePrecision));

  return {
    n: rows.length,
    accuracy,
    f1: mean(rows.map((row) => row.f1)),
    evidenceRecall: recalls.length === 0 ? null : mean(recalls),
    evidencePrecision: precisions.length === 0 ? null : mean(precisions),
    finalInputTokens: mean(rows.map((row) => row.finalInputTokens)),
    toolCalls: mean(rows.map((row) => row.toolCalls)),
    // Binomial standard error. Rows from repeats of the same question are not
    // independent, so this understates the true spread — it is a guide to
    // whether a gap is worth believing, not a p-value.
    stderr: rows.length === 0 ? 0 : Math.sqrt((accuracy * (1 - accuracy)) / rows.length),
  };
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

export interface ReportHeader {
  readonly runId: string;
  readonly seed: number;
  readonly model: string;
  readonly effort: string;
  readonly repeats: number;
  readonly maxToolCalls: number;
  readonly embedder: string;
  readonly mapping: string;
  /** Where the agent ran. Two providers are two runs, never two columns. */
  readonly provider: string;
  readonly thinking: boolean;
  readonly warnings: readonly string[];
}

export function renderReport(
  header: ReportHeader,
  rows: readonly RunRecord[],
  categories: readonly Category[],
): string {
  const adapters = [...new Set(rows.map((row) => row.adapter))];
  const lines: string[] = [];

  lines.push(`# Ingot retrieval benchmark — ${header.runId}`);
  lines.push('');
  lines.push(
    `seed \`${header.seed}\` · provider \`${header.provider}\` · model \`${header.model}\` · ` +
      `${header.thinking ? `effort \`${header.effort}\`` : 'thinking off'} · ` +
      `${header.repeats} run(s) per question · budget ${header.maxToolCalls} tool calls · ` +
      `embedder \`${header.embedder}\` · ingot mapping \`${header.mapping}\``,
  );
  lines.push('');

  for (const warning of header.warnings) lines.push(`> **${warning}**`);
  if (header.warnings.length > 0) lines.push('');

  lines.push('## Accuracy by category');
  lines.push('');
  lines.push(`| adapter | overall | ${categories.join(' | ')} |`);
  lines.push(`| --- | --- | ${categories.map(() => '---').join(' | ')} |`);
  for (const adapter of adapters) {
    const all = rows.filter((row) => row.adapter === adapter);
    const overall = summarise(all);
    const cells = categories.map((category) => {
      const subset = all.filter((row) => row.category === category);
      return subset.length === 0 ? '—' : percent(summarise(subset).accuracy);
    });
    lines.push(
      `| ${adapter} | ${percent(overall.accuracy)} ±${percent(overall.stderr)} | ${cells.join(' | ')} |`,
    );
  }
  lines.push('');
  lines.push(
    '_A `—` is a cell with no runs in it, not a zero. `oracle` has one for every category ' +
      'whose answer is a statistic rather than a set of records: there is no evidence to place ' +
      'in the prompt, so there is no ceiling to be had, and its overall is therefore taken over ' +
      'fewer questions than the other rows. `raw-context` is the ceiling for those._',
  );
  lines.push('');

  lines.push('## Retrieval and cost');
  lines.push('');
  lines.push(
    '| adapter | set F1 | evidence recall | evidence precision | tool calls | context tokens |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const adapter of adapters) {
    const cell = summarise(rows.filter((row) => row.adapter === adapter));
    lines.push(
      `| ${adapter} | ${cell.f1.toFixed(2)} | ` +
        `${cell.evidenceRecall === null ? '—' : percent(cell.evidenceRecall)} | ` +
        `${cell.evidencePrecision === null ? '—' : percent(cell.evidencePrecision)} | ` +
        `${cell.toolCalls.toFixed(1)} | ${Math.round(cell.finalInputTokens).toLocaleString()} |`,
    );
  }
  lines.push('');
  lines.push(
    '_Evidence recall and precision are computed only over questions whose answer is a set of ' +
      'records. Questions answered with a statistic (the `aggregate` category) have no ' +
      'record-level evidence — a correct count is its own evidence — and are scored on the ' +
      'answer alone._',
  );
  lines.push('');
  lines.push(
    '_Context tokens is the input-token count of the final request: what the model had to ' +
      'read to produce the answer. It is the column where a query that returns three rows ' +
      'separates from a search that returns fifty._',
  );
  lines.push('');

  return lines.join('\n');
}

/** The console view, so a run says something useful before it finishes. */
export function renderLine(row: RunRecord): string {
  const mark = row.correct ? '✓' : '✗';
  const recall = row.evidenceRecall === null ? '  —' : percent(row.evidenceRecall).padStart(4);
  return (
    `${mark} ${row.adapter.padEnd(18)} ${row.questionId} ${row.category.padEnd(9)} ` +
    `recall=${recall} calls=${String(row.toolCalls).padStart(2)} ` +
    `ctx=${String(row.finalInputTokens).padStart(6)}`
  );
}
