import { InvariantViolation } from '../../../../shared/domain/index.js';
import {
  type Block,
  BlockKind,
  Boundary,
  ByteShape,
  type FormatHandler,
  type ParseInput,
  type ParsedDocument,
} from '../format.js';
import { MediaType } from '../media-type.js';
import { readParts } from './office-zip.js';
import { paragraphsOf, type WordParagraph } from './word-text.js';
import { elementText } from './xml-text.js';

const DOCUMENT = 'word/document.xml';
const CORE = 'docProps/core.xml';

/**
 * A Word document, read as blocks grouped by heading hierarchy.
 *
 * Unlike slides, a document is continuous prose with structure from heading
 * styles. Headings are real — Word records them explicitly — so `carryHeadings`
 * prepends them to the embedded text and retrieval works as it should.
 *
 * The chunking boundary is `Heading`, which means:
 * - A heading starts a new group
 * - Body paragraphs under a heading merge into one block
 * - Long sections split with overlap (prose, not discrete records)
 */
export const docxHandler: FormatHandler = {
  mediaType: MediaType.Docx,
  extensions: ['docx'],
  shape: ByteShape.Zip,
  tabular: false,
  chunking: { boundary: Boundary.Heading, overlap: true, carryHeadings: true },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const parts = readParts(input.content, (name) => name === DOCUMENT || name === CORE);

    const document = parts.get(DOCUMENT);
    if (!document) {
      throw new InvariantViolation(
        `"${input.filename}" is a zip archive but has no document.xml in it. It may be a .pptx ` +
          'or .xlsx that was sent as a Word document — every Office format is a zip, so the ' +
          'extension is the only thing that distinguishes them until this point.',
      );
    }

    const paragraphs = paragraphsOf(document);
    const blocks = groupByHeadings(paragraphs);

    return {
      blocks,
      pages: null, // Word documents don't have meaningful page numbers at parse time
      title: declaredTitle(parts) ?? firstHeading(paragraphs),
      rows: null,
    };
  },
};

/**
 * Groups paragraphs by heading hierarchy.
 *
 * Each heading starts a new block. Body paragraphs accumulate under the current
 * heading path. If no headings exist, everything becomes one block.
 */
function groupByHeadings(paragraphs: readonly WordParagraph[]): Block[] {
  if (paragraphs.length === 0) return [];

  const blocks: Block[] = [];
  let currentHeadings: string[] = [];
  let currentText: string[] = [];

  for (const para of paragraphs) {
    if (para.headingLevel !== null) {
      // Flush accumulated text before starting new section
      if (currentText.length > 0) {
        blocks.push(makeBlock(currentHeadings, currentText));
        currentText = [];
      }

      // Update heading path: trim to parent level, then add this heading
      currentHeadings = currentHeadings.slice(0, para.headingLevel - 1);
      currentHeadings[para.headingLevel - 1] = para.text;
    } else {
      currentText.push(para.text);
    }
  }

  // Flush final section
  if (currentText.length > 0) {
    blocks.push(makeBlock(currentHeadings, currentText));
  }

  // If no blocks (document was only headings), create blocks from headings
  if (blocks.length === 0) {
    for (const para of paragraphs) {
      if (para.headingLevel !== null) {
        blocks.push({
          text: '',
          page: null,
          headings: [para.text],
          hard: false,
          kind: BlockKind.Prose,
        });
      }
    }
  }

  return blocks;
}

function makeBlock(headings: readonly string[], paragraphs: readonly string[]): Block {
  return {
    text: paragraphs.join('\n\n'),
    page: null,
    headings: [...headings].filter((h) => h !== undefined),
    hard: false,
    kind: BlockKind.Prose,
  };
}

function declaredTitle(parts: Map<string, string>): string | null {
  const core = parts.get(CORE);
  return core ? elementText(core, 'title') : null;
}

function firstHeading(paragraphs: readonly WordParagraph[]): string | null {
  for (const para of paragraphs) {
    if (para.headingLevel !== null) return para.text;
  }
  return null;
}
