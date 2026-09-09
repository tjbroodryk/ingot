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

/**
 * How many pages one document may have.
 *
 * A thousand pages at a few hundred words each is already past what anybody
 * usefully searches as a single document, and it is several thousand chunks and
 * several thousand embeddings from one HTTP request. Beyond this the honest
 * answer is that the document should be split before it is uploaded.
 */
const MAX_PAGES = 1_000;

/** What `pdfjs` hands back per text run. Only two fields are ever used. */
interface TextItem {
  readonly str: string;
  readonly hasEOL?: boolean;
}

/**
 * As much of `pdfjs`'s document as this file touches, written out.
 *
 * Structural rather than imported from `pdfjs-dist/types`, because those types
 * come through a dynamic import of an ESM build and naming them properly means
 * `Awaited<ReturnType<…>>` three deep — a signature nobody can read, describing
 * four fields. This says the same thing and says it once.
 */
interface PdfDocument {
  readonly numPages: number;
  getPage(number: number): Promise<{
    getTextContent(): Promise<{ items: readonly unknown[] }>;
    cleanup(): void;
  }>;
  getMetadata(): Promise<{ info?: unknown }>;
  destroy(): Promise<void>;
}

/**
 * The library, loaded once and on first use.
 *
 * `pdfjs` ships ESM and this package is CommonJS, so it comes in through a
 * dynamic import — which also means a deployment that never uploads a PDF never
 * pays to load ten megabytes of it. Held as a promise rather than a value so
 * that two concurrent parses share one load rather than racing it.
 */
let library: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

function load(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  library ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return library;
}

/**
 * A PDF, read one page at a time.
 *
 * **Pages are the only structure a PDF reliably has**, and this handler is built
 * on exactly that and nothing more. A PDF has no headings — what looks like one
 * is a font size, and inferring a hierarchy from font runs is a guess wrong
 * often enough to poison an embedding rather than help it. So blocks come out
 * with a real `page` and empty `headings`, and `chunking` says
 * `carryHeadings: false` to match. That is a smaller claim than the Markdown
 * handler makes, and it is the true one.
 *
 * ## What is switched off, and why every one of them matters
 *
 * `pdfjs` is a full PDF implementation, and a PDF is a document format with a
 * scripting engine, an embedded font system and the ability to reference things
 * over a network. Handed an upload from anyone holding an API key, every one of
 * those is somebody else's decision about what this process does:
 *
 * - `isEvalSupported` — PDF has JavaScript. Nothing here needs to run it.
 * - `disableFontFace`, `useSystemFonts` — no font is installed or drawn from,
 *   because text extraction needs the characters and not the glyphs.
 * - `disableAutoFetch`, `disableStream` — the whole document is in memory
 *   already, so there is nothing to range-request and nowhere to request from.
 * - **No `cMapUrl` and no `standardFontDataUrl` are given at all.** That is the
 *   quiet one: those are the two options that make `pdfjs` fetch, and the
 *   defence is not configuring them rather than configuring them safely.
 *
 * The interface's rule is that a handler fetches nothing. This is what that
 * costs for the one format where it is not automatic.
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
      // A copy, because `pdfjs` takes ownership of the buffer it is given and
      // transfers it away — leaving the caller's `Buffer` detached. The same
      // bytes are wanted afterwards for the sha256 and for a re-parse.
      data: new Uint8Array(input.content),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      /*
       * Errors only, and this one is not about tidiness.
       *
       * `pdfjs` warns once per page that `standardFontDataUrl` was not given,
       * because it cannot load the fonts it would need to *draw* the text. We do
       * not draw anything — extraction needs the characters, not the glyphs — so
       * the warning is about a thing we deliberately did not configure, on every
       * page of every document. At a thousand pages that is a thousand lines
       * saying the same non-fact, and a log that noisy is one nobody reads the
       * real error out of.
       *
       * The alternative was to point the option at the package's own font
       * directory, which would mean handing an untrusted document's font
       * requests a filesystem path to resolve against. Not configuring it is the
       * safer half of the trade; this is the other half.
       */
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

      return { blocks, pages: document.numPages, title: await title(document), rows: null };
    } finally {
      // Releases the worker and the page cache. Without it a parse leaks for the
      // life of the process, which for this queue means every document.
      await document.destroy().catch(() => undefined);
    }
  },
};

async function page(document: PdfDocument, number: number): Promise<Block> {
  const handle = await document.getPage(number);

  try {
    const content = await handle.getTextContent();
    return {
      text: join(content.items as TextItem[]),
      page: number,
      // Empty on purpose. See above: a PDF's headings are a guess from font
      // sizes, and a wrong one embedded is worse than none.
      headings: [],
      // The page boundary comes from `chunking` rather than from here, so that a
      // caller's chunk budget can still split a very long page.
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
    // Producers write the source filename here constantly — `Microsoft Word -
    // report.docx` — which is not a title, it is a breadcrumb, and embedding it
    // would rank this document against every other one exported the same way.
    if (found.length === 0 || /^(microsoft word|untitled|document\d*)\b/i.test(found)) return null;
    return found;
  } catch {
    // Metadata is a bonus. A document that has none, or has some this cannot
    // read, is still a document worth every chunk in it.
    return null;
  }
}

/**
 * The runs of one page, joined back into lines.
 *
 * `hasEOL` is `pdfjs` telling us where the text layer itself put a break, which
 * is the best signal available — the alternative is clustering by the `y` of
 * each item's transform, which is what a layout-aware extractor does and which
 * gets tables badly wrong in a different way.
 *
 * Runs of blank lines are collapsed because a PDF's text layer emits an EOL per
 * visual line, so a paragraph gap arrives as several — and the chunker splits
 * oversized blocks on blank-line runs, which would otherwise find a boundary
 * between every pair of lines.
 */
function join(items: readonly TextItem[]): string {
  return items
    .map((item) => (item.hasEOL ? `${item.str}\n` : item.str))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A refusal somebody can act on, rather than the library's own words.
 *
 * The two cases worth naming are the two a caller can actually do something
 * about: a password, and a file that is not really a PDF. Everything else is
 * passed through, because a corrupt document has no useful advice attached.
 */
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
