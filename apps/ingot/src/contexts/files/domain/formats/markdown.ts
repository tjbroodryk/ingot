import {
  Boundary,
  ByteShape,
  type FormatHandler,
  type ParseInput,
  type ParsedDocument,
} from '../format.js';
import { MediaType } from '../media-type.js';
import { atxHeading, decodeText, documentOf, headedBlocks } from './blocks.js';

/**
 * Markdown: a heading hierarchy that is explicit and therefore trustworthy.
 *
 * `carryHeadings` is on because of that. A chunk reading "…within thirty days of
 * written notice" ranks against "what is the termination notice period" only if
 * "4.2 Notice" travels with it, and here the heading is a fact the author wrote
 * rather than something inferred from a font size.
 */
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
