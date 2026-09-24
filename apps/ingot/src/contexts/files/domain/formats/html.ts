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
 * HTML, reduced to text with its headings turned into Markdown ones, so the
 * Markdown path does the structural half.
 */
export const htmlHandler: FormatHandler = {
  mediaType: MediaType.Html,
  extensions: ['html', 'htm'],
  shape: ByteShape.Text,
  tabular: false,
  chunking: { boundary: Boundary.Heading, overlap: true, carryHeadings: true },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    return documentOf(headedBlocks(toMarkdown(decodeText(input.content)), atxHeading));
  },
};

/** Script and style are stripped whole, contents included. */
function toMarkdown(html: string): string {
  return (
    html
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${strip(body)}\n\n`,
      )
      // Block-level tags become paragraph breaks, which is what the splitter
      // downstream reads. Everything else simply disappears.
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Last, so `&amp;lt;` becomes the literal `&lt;` rather than `<`.
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
  );
}

function strip(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}
