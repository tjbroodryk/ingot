import type { ToolResult } from '../corpus/stream.js';
import type { AdapterTool, MemoryAdapter } from './types.js';

/**
 * The control, which is what makes every other number readable.
 *
 * Without it a table of percentages has no scale: nobody can tell whether 61%
 * is close to the ceiling or half of it, and a benchmark whose headline number
 * cannot be calibrated is a marketing asset rather than a measurement.
 *
 * There used to be a second one. `oracle` placed exactly the answer-bearing
 * records in the prompt and was described as perfect retrieval, which it was
 * not: it received the records that *constitute* an answer and never the ones
 * that establish why they are the answer. On a question whose predicate spans
 * two record types — the answer is pull requests, the proof is CI runs — it
 * was asked to assert what its prompt could not support, and it answered
 * nothing. A ceiling that sits below the columns it is meant to bound is worse
 * than no ceiling, because a reader takes the gap for a finding. `raw-context`
 * bounds the model with strictly more information and needs no caveat.
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
