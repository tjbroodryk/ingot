import {
  Boundary,
  ByteShape,
  type FormatHandler,
  type ParseInput,
  type ParsedDocument,
} from '../format.js';
import { MediaType } from '../media-type.js';
import { decodeText, documentOf, headedBlocks } from './blocks.js';

/** Plain text: paragraphs, and nothing else to go on. */
export const textHandler: FormatHandler = {
  mediaType: MediaType.Text,
  extensions: ['txt', 'text'],
  shape: ByteShape.Text,
  tabular: false,
  chunking: { boundary: Boundary.Budget, overlap: true, carryHeadings: false },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    // No heading function: a plain paragraph splitter.
    return documentOf(headedBlocks(decodeText(input.content), null));
  },
};
