import type { ToolResult } from '../corpus/stream.js';
import type { AdapterTool, MemoryAdapter } from './types.js';

/**
 * No retrieval at all: the entire corpus in the prompt. The ceiling for a
 * corpus that fits in the window, and the cost baseline for the token column.
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
