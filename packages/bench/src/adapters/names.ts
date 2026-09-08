/**
 * What a column used to be called.
 *
 * Columns get renamed, because a name that misleads costs more than the churn
 * of changing it — `ingot` beside `ingot-rest` read as the product beside a
 * variant, `recall-only` was read as "SQL only" by people who had just been
 * told otherwise, and `ingot-mcp-text-search-only` read as Ingot with a limb
 * off rather than as the control it is. But a rename lands on two things that
 * outlive the decision: the command in somebody's shell history, and the rows
 * already bought.
 *
 * So this maps old to current, and both places use it. `cli.ts` resolves what
 * was typed, and `store.ts` resolves what was stored — a run bought in
 * September carries the name it was bought under, for ever, and reading it
 * back gives the column its current name without touching the transcript. The
 * JSONL is the record; renaming inside it would be editing history to match a
 * decision made afterwards.
 *
 * Keys are every spelling that has ever been valid. Values must be names in
 * `ADAPTERS`, and `adapters.test.ts` holds that.
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
