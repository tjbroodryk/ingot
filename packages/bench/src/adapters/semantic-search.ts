import { schema, type AdapterTool } from './types.js';

/**
 * The one surface every top-k baseline is reached through — same note, tool
 * name, arguments and `k` — so only the retrieval differs. `ingot-rest`'s
 * `search` is held to the same shape.
 */

/** Ceiling on `k`. */
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
 * Renders hits in the one format every baseline answers in. A missing score is
 * `null`, not zero, so the model does not read it as "nothing matched".
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
