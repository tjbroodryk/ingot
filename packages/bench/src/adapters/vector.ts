import { flattenRecords, type CorpusRecord } from '../corpus/records.js';
import type { ToolResult } from '../corpus/stream.js';
import { cosine, type Embedder } from '../embed/embedder.js';
import { schema, type AdapterTool, type MemoryAdapter } from './types.js';

const MAX_K = 50;

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
    return (
      'Your memory is a semantic index over the stored records. ' +
      'The only way to reach it is `search`, which returns the records whose ' +
      'text is closest in meaning to your query.'
    );
  }

  tools(): readonly AdapterTool[] {
    return [
      {
        name: 'search',
        description:
          'Search the stored records by meaning. Returns the k records closest to your query, ' +
          'best first, with a similarity score.',
        input_schema: schema(
          {
            query: { type: 'string', description: 'What you are looking for, in plain language' },
            k: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_K,
              description: `How many records to return. Default 10, maximum ${MAX_K}.`,
            },
          },
          ['query'],
        ),
      },
    ];
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (name !== 'search') throw new Error(`${this.name}: no tool named ${name}`);

    const query = String(input.query ?? '');
    const k = Math.min(Number(input.k ?? 10) || 10, MAX_K);
    const [queryVector] = await this.embedder.embed([query]);
    if (!queryVector) throw new Error('embedder returned nothing for the query');

    const ranked = this.records
      .map((record, index) => ({
        record,
        score: cosine(queryVector, this.vectors[index] ?? []),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    if (ranked.length === 0) return 'No records.';
    return ranked
      .map((hit, position) => `#${position + 1} score=${hit.score.toFixed(4)}\n${hit.record.text}`)
      .join('\n\n');
  }

  async teardown(): Promise<void> {
    this.records = [];
    this.vectors = [];
  }
}
