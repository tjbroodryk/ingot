import { Injectable } from '@nestjs/common';
import {
  clamp,
  type Receipt,
  type ReceiptRequest,
  MAX_SEARCH_TERM_CHARS,
  MAX_SUMMARY_CHARS,
  type Summariser,
} from './summariser.port.js';

/** How many field names a summary names before it stops listing them. */
const NAMED_FIELDS = 6;
/** How many distinctive words the predicted search term is built from. */
const TERM_WORDS = 8;

/**
 * A deterministic, offline stand-in: the schema, the shape, and the words that
 * actually distinguish this result.
 *
 * The counterpart to `HashEmbedder`, and the default for the same reason. The
 * whole receipt path — the queue, the sweeper, the `ingot_receipts` table, three
 * embeddings per call, the roll-up that folds them into Parquet — is machinery
 * worth exercising on every test run, and none of it should need a network, a
 * key and a bill to exercise. This makes that possible.
 *
 * What it produces is honest but mechanical: it says what the table is, how
 * many rows arrived and which fields carry them, and it predicts a search term
 * from the least common words in the blob. That is genuinely better than
 * nothing for finding a result again — the table name and its identifiers are
 * usually what somebody half-remembers — and it is nowhere near an LLM's
 * précis. `INGOT_SUMMARISER` selects one of those; this one says so at boot.
 */
@Injectable()
export class ExtractiveSummariser implements Summariser {
  readonly model = 'extractive-v1';

  async summarise(request: ReceiptRequest): Promise<Receipt> {
    return { summary: this.summary(request), searchTerm: this.searchTerm(request) };
  }

  private summary(request: ReceiptRequest): string {
    const named = request.columns
      .filter((column) => !column.name.startsWith('_'))
      .slice(0, NAMED_FIELDS);
    const fields = named.map((column) => `${column.name} (${column.type})`).join(', ');
    const more = request.columns.length - named.length;

    return clamp(
      `${request.rows} row${request.rows === 1 ? '' : 's'} written to "${request.table}"` +
        (fields ? `, carrying ${fields}` : '') +
        (more > 0 ? ` and ${more} more column${more === 1 ? '' : 's'}` : '') +
        '. Summarised without a model, so this describes the shape of the ' +
        'result rather than its meaning.',
      MAX_SUMMARY_CHARS,
    );
  }

  /**
   * The table name, then the words that appear least often.
   *
   * Rarity rather than frequency, because a tool result's common words are
   * its keys — `id`, `name`, `url` — and those are exactly the ones that do
   * not distinguish it from every other result in the memory. What somebody
   * half-remembers is the odd one: a branch name, a file path, an error.
   */
  private searchTerm(request: ReceiptRequest): string {
    const counts = new Map<string, number>();
    for (const word of words(request.body)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }

    const distinctive = [...counts.entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(0, TERM_WORDS)
      .map(([word]) => word);

    return clamp([request.table, ...distinctive].join(' '), MAX_SEARCH_TERM_CHARS);
  }
}

/**
 * Words worth ranking on.
 *
 * Very short tokens and bare numbers are dropped: they are punctuation of the
 * JSON rather than content, and a search term made of `1`, `id` and `of` ranks
 * against everything equally, which is the same as ranking against nothing.
 */
function words(body: string): string[] {
  return body
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((word) => word.length >= 4 && !/^\d+$/.test(word));
}
