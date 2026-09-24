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
import type { PageImage } from '../../../../ai/ocr.port.js';
import { MediaType } from '../media-type.js';
import { pageImage } from './page-image.js';

/** How many pages one document may have. */
const MAX_PAGES = 1_000;

/** What `pdfjs` hands back per text run. Only two fields are ever used. */
interface TextItem {
  readonly str: string;
  readonly hasEOL?: boolean;
}

/** As much of `pdfjs`'s document as this file touches. */
interface PdfDocument {
  readonly numPages: number;
  getPage(number: number): Promise<{
    getTextContent(): Promise<{ items: readonly unknown[] }>;
    getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
    objs: { get(name: string, callback: (value: unknown) => void): void };
    cleanup(): void;
  }>;
  getMetadata(): Promise<{ info?: unknown }>;
  destroy(): Promise<void>;
}

/**
 * The library, loaded once on first use via dynamic import (`pdfjs` is ESM).
 * Held as a promise so concurrent parses share one load.
 */
let library: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

function load(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  library ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return library;
}

/**
 * A PDF, read one page at a time.
 *
 * Pages are the only structure a PDF reliably has, so blocks carry a real `page`
 * and empty `headings`, and `chunking` sets `carryHeadings: false`.
 *
 * Everything that could fetch or execute is switched off: `isEvalSupported`
 * (PDF has JavaScript), fonts, auto-fetch and streaming, and no `cMapUrl` or
 * `standardFontDataUrl` is given — the two options that would make `pdfjs` fetch.
 */
export const pdfHandler: FormatHandler = {
  mediaType: MediaType.Pdf,
  extensions: ['pdf'],
  shape: ByteShape.Pdf,
  tabular: false,
  chunking: { boundary: Boundary.Page, overlap: true, carryHeadings: false },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const pdfjs = await load();

    const task = pdfjs.getDocument({
      // A copy: `pdfjs` takes ownership of the buffer and detaches it, but the
      // bytes are wanted again afterwards.
      data: new Uint8Array(input.content),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      // Errors only. `pdfjs` otherwise warns once per page that
      // `standardFontDataUrl` was not given — a font it would need to draw,
      // which extraction does not do.
      verbosity: 0,
    });

    const document: PdfDocument = await task.promise.catch((error: unknown) => {
      throw new InvariantViolation(readable(error, input.filename));
    });

    try {
      if (document.numPages > MAX_PAGES) {
        throw new InvariantViolation(
          `"${input.filename}" has ${document.numPages} pages, and this service reads at most ` +
            `${MAX_PAGES} from one document. Split it and upload the parts.`,
        );
      }

      const blocks: Block[] = [];
      for (let number = 1; number <= document.numPages; number++) {
        blocks.push(await page(document, number));
      }

      return {
        blocks: await read(blocks, document, input, pdfjs.OPS.paintImageXObject),
        pages: document.numPages,
        title: await title(document),
        rows: null,
      };
    } finally {
      // Releases the worker and page cache; without it every parse leaks.
      await document.destroy().catch(() => undefined);
    }
  },
};

/**
 * Fills blank pages by OCR, where an engine is configured.
 *
 * Only a page with no text at all is sent; each keeps its own provenance. Blank
 * stays blank on any failure — no engine, no image, a refusal, or past the cap.
 */
async function read(
  blocks: readonly Block[],
  document: PdfDocument,
  input: ParseInput,
  paintImageXObject: number,
): Promise<Block[]> {
  const ocr = input.ocr;
  if (!ocr) return [...blocks];

  const blank = blocks.flatMap((block, at) => (block.text.length === 0 ? [at] : []));
  if (blank.length === 0) return [...blocks];

  // In page order, so a document past the cap spends its budget on its beginning.
  const images: PageImage[] = [];
  for (const at of blank.slice(0, ocr.maxPages)) {
    const number = blocks[at]?.page ?? at + 1;
    const handle = await document.getPage(number);

    try {
      const image = await pageImage(handle, number, paintImageXObject);
      if (image) images.push(image);
    } finally {
      handle.cleanup();
    }
  }

  if (images.length === 0) return [...blocks];

  const texts = await ocr.read(images);
  const byPage = new Map(images.map((image, at) => [image.number, texts[at] ?? null]));

  return blocks.map((block, at) => {
    if (!blank.includes(at)) return block;

    const found = byPage.get(block.page ?? at + 1);
    return found ? { ...block, text: found.text, ocr: found.engine } : block;
  });
}

async function page(document: PdfDocument, number: number): Promise<Block> {
  const handle = await document.getPage(number);

  try {
    const content = await handle.getTextContent();
    return {
      text: join(content.items as TextItem[]),
      page: number,
      // Empty on purpose: a PDF's headings are a guess from font sizes.
      headings: [],
      // The page boundary comes from `chunking`, so a long page can still be split.
      hard: false,
      kind: BlockKind.Prose,
    };
  } finally {
    handle.cleanup();
  }
}

async function title(document: PdfDocument): Promise<string | null> {
  try {
    const metadata = await document.getMetadata();
    const declared = (metadata.info as { Title?: unknown } | undefined)?.Title;
    if (typeof declared !== 'string') return null;

    const found = declared.trim();
    // Producers write the source filename here, which is a breadcrumb, not a title.
    if (found.length === 0 || /^(microsoft word|untitled|document\d*)\b/i.test(found)) return null;
    return found;
  } catch {
    // Metadata is a bonus; a document without it is still worth its chunks.
    return null;
  }
}

/**
 * The runs of one page, joined back into lines on `pdfjs`'s `hasEOL`.
 *
 * Blank-line runs are collapsed: the text layer emits an EOL per visual line,
 * and the chunker splits oversized blocks on blank-line runs.
 */
function join(items: readonly TextItem[]): string {
  return items
    .map((item) => (item.hasEOL ? `${item.str}\n` : item.str))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A refusal a caller can act on: names the password and not-a-PDF cases. */
function readable(error: unknown, filename: string): string {
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = error instanceof Error ? error.message : String(error);

  if (name === 'PasswordException') {
    return (
      `"${filename}" is password-protected. This service has nowhere to put a password and ` +
      'would not keep one if it did — remove the protection and upload it again.'
    );
  }
  if (name === 'InvalidPDFException') {
    return `"${filename}" is not a PDF this service can read: ${message}`;
  }
  return `"${filename}" could not be read: ${message}`;
}
