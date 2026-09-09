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
  readonly perTemplate: number;
  readonly maxToolCalls: number;
  /**
   * Agent runs in flight at once. Provenance rather than trivia: above 1 the
   * `ms` on every row was measured against a loaded provider, so latency is
   * comparable within the run and not with a run that had the API to itself.
   */
  readonly concurrency: number;
  readonly embedder: string;
  readonly mapping: string;
  /**
   * Log lines in the corpus, as one unpaginated tool result. 0 for the
   * ordinary corpus.
   *
   * Provenance rather than trivia: at any interesting value this is the run
   * where `raw-context` is refused rather than scored, so a report that did
   * not say which kind of run it was would be two different experiments under
   * one heading.
   */
  readonly logs: number;
  /**
   * Whether the corpus was rendered with schema drift. False for the ordinary
   * corpus, and false on any run bought before the flag existed.
   *
   * Provenance rather than trivia, for the same reason `logs` is: the two are
   * different experiments over the same questions. A drifted run asks what
   * survives a payload shape that changes underneath the agent, and reading
   * its numbers as though they came from the ordinary corpus would understate
   * every column in the table — the Ingot ones most of all, which is the
   * direction that makes forgetting to say so a comfortable mistake.
   */
  readonly drift: boolean;
  /**
   * Operational facts about how the run was executed, kept out of the
   * published summary.
   *
   * The split is between "you should read the numbers differently" and "here
   * is how the machine was driven". An offline embedder or reasoning switched
   * off changes what the table means and belongs in front of every reader; a
   * concurrency setting that moves only the `ms` column, or an adapter that
   * was skipped and is present anyway, is operator detail. Publishing the
   * second kind trains readers to skip the block that carries the first.
   */
  readonly notes: readonly string[];
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
      `${header.repeats} run(s) per question · ${header.perTemplate} per template · ` +
      `budget ${header.maxToolCalls} tool calls · ` +
      `${header.concurrency === 1 ? 'serial' : `${header.concurrency} in flight`} · ` +
      `embedder \`${header.embedder}\` · ingot mapping \`${header.mapping}\`` +
      // Only when it is on. A `drift off` on every ordinary report would be a
      // word every reader learns to skip, and the whole value of the stamp is
      // that it is noticed on the one run where it matters.
      (header.drift ? ' · **corpus drift on**' : ''),
  );
  lines.push('');

  for (const warning of header.warnings) lines.push(`> **${warning}**`);
  if (header.warnings.length > 0) lines.push('');

  // Local report only — see `notes` on the header.
  for (const note of header.notes ?? []) lines.push(`> ${note}`);
  if ((header.notes ?? []).length > 0) lines.push('');

  // Runs that never produced an answer, counted apart from runs that produced
  // a wrong one. They are scored wrong either way — nothing came back — but a
  // column whose zeroes are timeouts is not evidence about retrieval, and a
  // reader has to be able to see that before reading the tables.
  // `provider-error` is the string `loop.ts` actually writes when the provider
  // throws — a rate limit, a 500, a socket closed mid-stream. The filter here
  // looked for `error:`, which nothing has ever produced, so the banner has
  // been silent through every run that had infrastructure failures in it. That
  // is the worst way for this to be wrong: a column with a fifth of its runs
  // dead reads as a column that simply did badly.
  //
  // `context-overflow` is deliberately not counted. A request refused because
  // the corpus does not fit is the most interesting outcome this benchmark can
  // produce, not a failure of the harness, and it has its own note.
  const failed = rows.filter(
    (row) => row.stopReason === 'provider-error' || row.stopReason?.startsWith('error:'),
  );
  if (failed.length > 0) {
    const byAdapter = new Map<string, number>();
    for (const row of failed) byAdapter.set(row.adapter, (byAdapter.get(row.adapter) ?? 0) + 1);
    lines.push(
      `> **${failed.length} of ${rows.length} runs failed outright** and are scored wrong: ` +
        `${[...byAdapter].map(([name, count]) => `${name} ${count}`).join(', ')}. ` +
        'These are infrastructure failures, not retrieval failures — the JSONL carries the reason ' +
        'on each row.',
    );
    lines.push('');
  }

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
    '_A `—` is a cell with no runs in it, not a zero: a category this run asked no questions ' +
      'in, or an adapter that never reached it._',
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
