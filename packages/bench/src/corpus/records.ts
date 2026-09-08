import type { ToolResult } from './stream.js';
import type { Ref } from './world.js';

/**
 * The corpus flattened to one document per record.
 *
 * This is the chunking the vector baselines get, and it is deliberately the
 * most favourable one available: a record boundary is a semantic boundary, so
 * nothing is split mid-object and no chunk mixes two records. Any weakness the
 * baselines show is therefore a weakness of top-k retrieval over a corpus, not
 * an artefact of a chunker chosen to make them look bad.
 */
export interface CorpusRecord {
  readonly ref: Ref;
  readonly tool: string;
  readonly item: Record<string, unknown>;
  readonly text: string;
}

interface Page {
  readonly items?: readonly Record<string, unknown>[];
}

export function flattenRecords(corpus: readonly ToolResult[]): readonly CorpusRecord[] {
  const records: CorpusRecord[] = [];
  for (const result of corpus) {
    const page = result.result as Page;
    for (const item of page.items ?? []) {
      const ref = item.ref;
      if (typeof ref !== 'string') continue;
      records.push({
        ref,
        tool: result.tool,
        item,
        // The tool name is part of the text because it is part of what the
        // record means — "author: gupta" is ambiguous without knowing it came
        // from a pull request listing.
        text: `source: ${result.tool}\n${JSON.stringify(item, null, 2)}`,
      });
    }
  }
  return records;
}

/**
 * Which known refs appear in a piece of text a tool handed back.
 *
 * Refs are shaped `pr:1421`, `inc:INC-03` — distinctive enough that a match is
 * not a coincidence, and present in every adapter's payloads, so this is one
 * measurement rather than six that have to be argued as equivalent.
 */
export function refsIn(text: string, known: ReadonlySet<Ref>): ReadonlySet<Ref> {
  const found = new Set<Ref>();
  for (const match of text.matchAll(/\b(?:svc|file|pr|ci|inc|iss):[A-Za-z0-9-]+/g)) {
    if (known.has(match[0])) found.add(match[0]);
  }
  return found;
}
