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
 * `rows` lets an `extract` resolve `from` paths against the records with no
 * model. The blocks are for a sheet nobody wrote an extraction for.
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
