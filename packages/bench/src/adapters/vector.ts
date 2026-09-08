import { flattenRecords, type CorpusRecord } from '../corpus/records.js';
import type { ToolResult } from '../corpus/stream.js';
import { cosine, type Embedder } from '../embed/embedder.js';
import {
  clampK,
  renderHits,
  SEMANTIC_SEARCH_NOTE,
  SEMANTIC_SEARCH_TOOL,
} from './semantic-search.js';
import type { AdapterTool, MemoryAdapter } from './types.js';

/**
 * The local vector baseline: embed every record, rank by cosine, return top-k.
 *
 * This is the shape of every "just put it in a vector store" answer, with the
 * hosted parts removed so that nothing about the comparison depends on a
 * third party's tuning. It is given every advantage that is cheap to give —
 * record-level chunking, the same embedding model Ingot is configured with,
 * and a `k` the model may raise to 50 — so that what it cannot do is a
 * property of top-k retrieval rather than of this implementation.
 */
export class VectorAdapter implements MemoryAdapter {
  readonly name: string;
  private records: readonly CorpusRecord[] = [];
  private vectors: number[][] = [];

  constructor(
    private readonly embedder: Embedder,
    name = 'vector',
  ) {
    this.name = name;
  }

  async ingest(corpus: readonly ToolResult[]): Promise<void> {
    this.records = flattenRecords(corpus);
    this.vectors = await this.embedder.embed(this.records.map((record) => record.text));
  }

  async systemNote(): Promise<string> {
    return SEMANTIC_SEARCH_NOTE;
  }

  tools(): readonly AdapterTool[] {
    return [SEMANTIC_SEARCH_TOOL];
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (name !== 'search') throw new Error(`${this.name}: no tool named ${name}`);

    const query = String(input.query ?? '');
    const k = clampK(input.k);
    const [queryVector] = await this.embedder.embed([query]);
    if (!queryVector) throw new Error('embedder returned nothing for the query');

    const ranked = this.records
      .map((record, index) => ({
        text: record.text,
        score: cosine(queryVector, this.vectors[index] ?? []),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return renderHits(ranked);
  }

  async teardown(): Promise<void> {
    this.records = [];
    this.vectors = [];
  }
}
