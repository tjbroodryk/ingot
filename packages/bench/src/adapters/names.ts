/**
 * Old adapter name → current name. `cli.ts` resolves what was typed and
 * `store.ts` what was stored, so a renamed column reads back under its current
 * name without rewriting the transcript.
 *
 * Keys are every spelling that has ever been valid; values must be names in
 * `ADAPTERS`.
 */
export const LEGACY_NAMES: Readonly<Record<string, string>> = {
  ingot: 'ingot-mcp',
  'ingot-recall-only': 'control-same-store-top-k',
  'ingot-mcp-text-search-only': 'control-same-store-top-k',
  'ingot-rest-recall-only': 'control-same-store-top-k-rest',
  'ingot-rest-text-search-only': 'control-same-store-top-k-rest',
};

/** The name a column goes by now, whatever it was called when it was written. */
export function canonicalAdapter(name: string): string {
  return LEGACY_NAMES[name] ?? name;
}
