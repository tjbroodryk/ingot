import {
  Boundary,
  ByteShape,
  type FormatHandler,
  type ParseInput,
  type ParsedDocument,
} from '../format.js';
import { MediaType } from '../media-type.js';
import { decodeText, documentOf, headedBlocks } from './blocks.js';

/**
 * Plain text: paragraphs, and nothing else to go on.
 *
 * The token window is what is left when a format volunteers no structure, not a
 * default the others fall back to. Every other handler has something better.
 */
export const textHandler: FormatHandler = {
  mediaType: MediaType.Text,
  extensions: ['txt', 'text'],
  shape: ByteShape.Text,
  tabular: false,
  chunking: { boundary: Boundary.Budget, overlap: true, carryHeadings: false },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    // No heading function: with nothing to recognise, this is a paragraph
    // splitter, which is the honest reading of a `.txt` file.
    return documentOf(headedBlocks(decodeText(input.content), null));
  },
};
