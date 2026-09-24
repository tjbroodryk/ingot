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
 * Deterministic, offline stand-in: names the table, its shape, and the words
 * that distinguish this result. The counterpart to `HashEmbedder`.
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
   * The table name, then the words that appear least often. Rarity, not
   * frequency: common words are keys (`id`, `name`, `url`) that distinguish nothing.
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

/** Words worth ranking on. Drops very short tokens and bare numbers as JSON punctuation. */
function words(body: string): string[] {
  return body
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((word) => word.length >= 4 && !/^\d+$/.test(word));
}
