import {
  Boundary,
  ByteShape,
  type FormatHandler,
  type ParseInput,
  type ParsedDocument,
} from '../format.js';
import { MediaType } from '../media-type.js';
import { atxHeading, decodeText, documentOf, headedBlocks } from './blocks.js';

/** Markdown: an explicit heading hierarchy, so `carryHeadings` is on. */
export const markdownHandler: FormatHandler = {
  mediaType: MediaType.Markdown,
  extensions: ['md', 'markdown'],
  shape: ByteShape.Text,
  tabular: false,
  chunking: { boundary: Boundary.Heading, overlap: true, carryHeadings: true },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    return documentOf(headedBlocks(decodeText(input.content), atxHeading));
  },
};
