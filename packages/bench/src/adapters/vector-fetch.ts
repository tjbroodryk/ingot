import type { ToolResult } from '../corpus/stream.js';
import type { Embedder } from '../embed/embedder.js';
import { renderHits, SEMANTIC_SEARCH_TOOL } from './semantic-search.js';
import { schema, type AdapterTool } from './types.js';
import { VectorAdapter } from './vector.js';

/** The ceiling on one `fetch_sources` call, so the budget still counts for something. */
export const MAX_FETCH = 10;

const NOTE =
  'Your memory is a semantic index over the stored records, plus the tool results they ' +
  'came from. `search` returns the records closest in meaning to your query, each marked ' +
  'with the id of its tool result. `list_sources` lists every stored tool result, and ' +
  '`fetch_sources` returns them whole, so you can read every record in a listing rather ' +
  'than only the ones a search ranked.';

const LIST_SOURCES_TOOL: AdapterTool = {
  name: 'list_sources',
  description:
    'List every stored tool result: its id, the tool that produced it, the arguments it ' +
    'was called with, and how many records it holds.',
  input_schema: schema({}),
};

const FETCH_SOURCES_TOOL: AdapterTool = {
  name: 'fetch_sources',
  description: `Return stored tool results whole, as the JSON they arrived as. At most ${MAX_FETCH} per call.`,
  input_schema: schema(
    {
      ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_FETCH,
        description: 'Tool result ids, from `search` or `list_sources`, e.g. "tr-004".',
      },
    },
    ['ids'],
  ),
};

/**
 * `vector`, plus a way back to the raw tool results behind the hits.
 *
 * This is the usual answer to "top-k misses rows": let the agent read the
 * source documents. The search is `vector`'s, same ranking and same tool, with
 * each hit naming its tool result. A separate column, so rows already bought
 * under `vector` still mean what they meant.
 */
export class VectorFetchAdapter extends VectorAdapter {
  private sources: ReadonlyMap<string, ToolResult> = new Map();

  constructor(embedder: Embedder, name = 'vector-fetch') {
    super(embedder, name);
  }

  override async ingest(corpus: readonly ToolResult[]): Promise<void> {
    await super.ingest(corpus);
    this.sources = new Map(corpus.map((result) => [result.id, result]));
  }

  override async systemNote(): Promise<string> {
    return NOTE;
  }

  override tools(): readonly AdapterTool[] {
    return [SEMANTIC_SEARCH_TOOL, LIST_SOURCES_TOOL, FETCH_SOURCES_TOOL];
  }

  override async call(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'search': {
        const ranked = await this.rank(input);
        return renderHits(
          ranked.map(({ record, score }) => ({
            text: `tool_result: ${record.source}\n${record.text}`,
            score,
          })),
        );
      }
      case 'list_sources':
        return [...this.sources.values()]
          .map(
            (result) =>
              `${result.id}  ${result.tool}  ${JSON.stringify(result.args)}  ${result.refs.length} records`,
          )
          .join('\n');
      case 'fetch_sources':
        return this.fetch(input.ids);
      default:
        throw new Error(`${this.name}: no tool named ${name}`);
    }
  }

  private fetch(asked: unknown): string {
    const ids = Array.isArray(asked) ? asked.map(String) : [];
    if (ids.length === 0) return 'No ids given.';

    const parts = ids.slice(0, MAX_FETCH).map((id) => {
      const result = this.sources.get(id);
      if (!result) return `## ${id}\nNo tool result with this id.`;
      return `## ${result.id} ${result.tool} ${JSON.stringify(result.args)}\n${JSON.stringify(result.result)}`;
    });
    if (ids.length > MAX_FETCH) {
      parts.push(`Dropped ${ids.length - MAX_FETCH} ids over the limit of ${MAX_FETCH}; ask again for them.`);
    }
    return parts.join('\n\n');
  }

  override async teardown(): Promise<void> {
    await super.teardown();
    this.sources = new Map();
  }
}
