import { schema, type AdapterTool } from './types.js';

/**
 * The one surface every top-k baseline is reached through.
 *
 * `vector`, `pinecone`, `turbopuffer` and `hyperspell` differ in where the
 * vectors live and how they are ranked. They must differ in nothing else that
 * reaches the model: the same system note, the same tool name, the same
 * arguments, the same `k`. That is written here once rather than four times
 * because four copies are four chances for one column to quietly acquire a
 * better-worded description than the others — and "only the retrieval
 * differs" is the claim the whole comparison rests on.
 *
 * `ingot-rest`'s `search` is deliberately held to the same shape for the same
 * reason, and a test in `adapters.test.ts` asserts it.
 */

/** The ceiling on `k`, so what top-k cannot do is not a stingy default. */
export const MAX_K = 50;

export const SEMANTIC_SEARCH_NOTE =
  'Your memory is a semantic index over the stored records. ' +
  'The only way to reach it is `search`, which returns the records whose ' +
  'text is closest in meaning to your query.';

export const SEMANTIC_SEARCH_TOOL: AdapterTool = {
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
};

/** `k` as the store will honour it: the model's ask, defaulted and capped. */
export function clampK(asked: unknown): number {
  return Math.min(Number(asked ?? 10) || 10, MAX_K);
}

/**
 * What comes back, in the one format every baseline answers in.
 *
 * A store that does not return a comparable score passes `null` rather than a
 * zero, because a printed `score=0.0000` would read to the model as "nothing
 * matched" and change how it uses the result.
 */
export function renderHits(
  hits: readonly { readonly score: number | null; readonly text: string }[],
): string {
  if (hits.length === 0) return 'No records.';
  return hits
    .map((hit, position) => {
      const score = hit.score === null ? '' : ` score=${hit.score.toFixed(4)}`;
      return `#${position + 1}${score}\n${hit.text}`;
    })
    .join('\n\n');
}
