import {
  BlockKind,
  Boundary,
  ByteShape,
  type FormatHandler,
  type ParseInput,
  type ParsedDocument,
} from '../format.js';
import { MediaType } from '../media-type.js';
import { decodeText } from './blocks.js';
import { parseDelimited, renderRows } from './delimited.js';

/**
 * A delimited file: real rows, and chunks only as a fallback.
 *
 * `rows` is the point of this handler and the reason `tabular` is a flag at all.
 * A CSV already has field names and records, so an `extract` over it resolves
 * `from` paths against these objects and goes through the ordinary `/add`
 * mapping with **no model involved** — which is both exact and free.
 *
 * The blocks are the consolation prize for a spreadsheet nobody wrote an
 * extraction for. Rendering rows as `header: value` text and embedding them is
 * strictly worse than extracting them into typed columns — a `WHERE total >
 * 10000` beats any similarity search over the same data — but it is a great deal
 * better than an upload that produces nothing at all, and it means a caller can
 * find the sheet before they have decided what to pull out of it.
 */
export const csvHandler: FormatHandler = {
  mediaType: MediaType.Csv,
  extensions: ['csv', 'tsv'],
  shape: ByteShape.Text,
  tabular: true,
  // No overlap: repeating half a record into the next chunk is duplication that
  // ranks against nothing.
  chunking: { boundary: Boundary.Budget, overlap: false, carryHeadings: false },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const rows = parseDelimited(decodeText(input.content));

    return {
      blocks: rows.map((row) => ({
        text: renderRows([row]),
        page: null,
        headings: [],
        hard: false,
        kind: BlockKind.Table,
      })),
      pages: null,
      title: null,
      rows,
    };
  },
};
