import { flattenRecords, type CorpusRecord } from '../corpus/records.js';
import type { ToolResult } from '../corpus/stream.js';
import type { Question } from '../questions/questions.js';
import type { AdapterTool, MemoryAdapter } from './types.js';

/**
 * The two controls, which are what make every other number readable.
 *
 * Without them a table of percentages has no scale: nobody can tell whether
 * 61% is close to the ceiling or half of it, and a benchmark whose headline
 * number cannot be calibrated is a marketing asset rather than a measurement.
 */

/**
 * No retrieval at all: the entire corpus in the prompt.
 *
 * The ceiling for a corpus that fits in the window, and the honest reminder
 * that for small memories the right answer is often to skip retrieval. It is
 * also the cost baseline — every other adapter should reach a similar score
 * for a fraction of the tokens, and the token column is where that shows.
 */
export class RawContextAdapter implements MemoryAdapter {
  readonly name = 'raw-context';
  private corpus: readonly ToolResult[] = [];

  async ingest(corpus: readonly ToolResult[]): Promise<void> {
    this.corpus = corpus;
  }

  async systemNote(): Promise<string> {
    const dump = this.corpus
      .map((result) => `## ${result.tool} (${result.id})\n${JSON.stringify(result.result)}`)
      .join('\n\n');
    return `Every tool result ever stored is reproduced below. You have no tools; answer from this.\n\n${dump}`;
  }

  tools(): readonly AdapterTool[] {
    return [];
  }

  async call(name: string): Promise<string> {
    throw new Error(`raw-context has no tools, got a call to ${name}`);
  }

  async teardown(): Promise<void> {
    this.corpus = [];
  }
}

/**
 * Perfect retrieval: exactly the records that constitute the answer, and
 * nothing else.
 *
 * The upper bound on what any retrieval interface could deliver to this model
 * on this question. A gap between `oracle` and a real adapter is retrieval; a
 * gap between `oracle` and 100% is the model's reasoning, and separating those
 * two is the reason to spend the money on it.
 */
export class OracleAdapter implements MemoryAdapter {
  readonly name = 'oracle';
  private byRef = new Map<string, CorpusRecord>();

  async ingest(corpus: readonly ToolResult[]): Promise<void> {
    this.byRef = new Map(flattenRecords(corpus).map((record) => [record.ref, record]));
  }

  /**
   * Aggregate questions have no record-level evidence — a count is its own
   * evidence — so there is no oracle context to build and the runner skips
   * them. `raw-context` is the ceiling for those: answering "how many CI runs
   * failed at step X" needs the whole corpus, not a subset of it, so the
   * control that holds the whole corpus is the one that bounds them.
   */
  supports(question: Question): boolean {
    return question.evidence !== null;
  }

  async systemNote(question: Question): Promise<string> {
    if (question.evidence === null) {
      // Unreachable through the runner, which honours `supports`. Kept so that
      // calling the adapter directly cannot quietly hand back a partial context
      // that would read as a ceiling.
      return 'ORACLE_UNAVAILABLE: this question is a statistic over the whole corpus.';
    }
    const dump = question.evidence
      .map((ref) => this.byRef.get(ref)?.text ?? `(missing record ${ref})`)
      .join('\n\n');
    return `The records that answer the question are reproduced below. You have no tools.\n\n${dump}`;
  }

  tools(): readonly AdapterTool[] {
    return [];
  }

  async call(name: string): Promise<string> {
    throw new Error(`oracle has no tools, got a call to ${name}`);
  }

  async teardown(): Promise<void> {
    this.byRef = new Map();
  }
}
