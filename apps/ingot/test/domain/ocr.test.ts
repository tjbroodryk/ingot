import { describe, expect, it } from 'bun:test';
import type { Ocr, PageImage, PageText } from '../../src/ai/ocr.port.js';
import { FallbackOcr } from '../../src/ai/model-ocr.js';
import { chunk } from '../../src/contexts/files/domain/chunker.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';
import { pdfHandler } from '../../src/contexts/files/domain/formats/pdf.js';
import { mixedPdf, pdf, scannedPdf } from '../support/pdf.js';

/**
 * Reading the pages a PDF has no text for.
 *
 * The whole feature is a fallback, and every assertion here is about the edge
 * of it rather than about OCR itself: which pages are sent, which are not,
 * what happens when nothing comes back, and what the chunk says about where
 * its text came from. Whether Tesseract can read a fax is Tesseract's business
 * and not something a unit test should be re-litigating.
 *
 * The engine is a stub throughout — no WASM, no model, no network — so this
 * runs in milliseconds and asserts the part this codebase actually wrote.
 */

/** An engine that reads every page, and remembers what it was given. */
class StubOcr implements Ocr {
  readonly seen: PageImage[] = [];

  constructor(
    readonly engine = 'stub',
    readonly maxPages = 20,
    private readonly answer: (page: PageImage) => PageText | null = (page) => ({
      text: `page ${page.number} says something`,
      engine: 'stub',
    }),
  ) {}

  read(pages: readonly PageImage[]): Promise<readonly (PageText | null)[]> {
    this.seen.push(...pages);
    return Promise.resolve(pages.map((page) => this.answer(page)));
  }
}

const file = { mediaType: MediaType.Pdf, filename: 'scan.pdf' };

describe('a PDF with no text layer', () => {
  it('leaves every page blank when no engine is configured', async () => {
    const parsed = await pdfHandler.parse({ content: scannedPdf(3), ...file, ocr: null });

    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks.map((block) => block.text)).toEqual(['', '', '']);
    expect(parsed.blocks.every((block) => block.ocr === undefined)).toBe(true);
  });

  it('sends the blank pages to the engine, and keeps what comes back', async () => {
    const ocr = new StubOcr();
    const parsed = await pdfHandler.parse({ content: scannedPdf(3), ...file, ocr });

    expect(ocr.seen.map((page) => page.number)).toEqual([1, 2, 3]);
    expect(parsed.blocks.map((block) => block.text)).toEqual([
      'page 1 says something',
      'page 2 says something',
      'page 3 says something',
    ]);
    // The provenance every one of these carries to a column.
    expect(parsed.blocks.map((block) => block.ocr)).toEqual(['stub', 'stub', 'stub']);
  });

  /**
   * A PNG, made without a renderer.
   *
   * The signature is the assertion worth making: it says the image XObject was
   * found, decoded by `pdfjs`, and wrapped by `page-image.ts` — the three steps
   * that let this work with no canvas and no native module in the image.
   */
  it('hands over each page as a PNG of the right size', async () => {
    const ocr = new StubOcr();
    await pdfHandler.parse({ content: scannedPdf(1, { width: 12, height: 20 }), ...file, ocr });

    const page = ocr.seen[0];
    expect(page).toBeDefined();
    expect(page?.width).toBe(12);
    expect(page?.height).toBe(20);
    expect([...(page?.png.subarray(0, 8) ?? [])]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('stops at the page cap, and spends it on the beginning of the document', async () => {
    const ocr = new StubOcr('stub', 2);
    const parsed = await pdfHandler.parse({ content: scannedPdf(5), ...file, ocr });

    expect(ocr.seen.map((page) => page.number)).toEqual([1, 2]);
    expect(parsed.blocks.map((block) => block.text)).toEqual([
      'page 1 says something',
      'page 2 says something',
      '',
      '',
      '',
    ]);
  });

  /**
   * A page an engine would not read stays exactly as blank as it was.
   *
   * The alternative — storing the refusal, or failing the document — would put
   * an apology in a chunk or throw away the pages that did work.
   */
  it('leaves a page the engine declined the blank it already was', async () => {
    const ocr = new StubOcr('stub', 20, (page) =>
      page.number === 2 ? null : { text: `page ${page.number}`, engine: 'stub' },
    );
    const parsed = await pdfHandler.parse({ content: scannedPdf(3), ...file, ocr });

    expect(parsed.blocks.map((block) => block.text)).toEqual(['page 1', '', 'page 3']);
    expect(parsed.blocks.map((block) => block.ocr)).toEqual(['stub', undefined, 'stub']);
  });
});

describe('a PDF that has its own text', () => {
  it('never reaches an engine, and costs nothing', async () => {
    const ocr = new StubOcr();
    const parsed = await pdfHandler.parse({
      content: pdf([['Reckonable membership', '14 years, 200 days']]),
      ...file,
      ocr,
    });

    expect(ocr.seen).toHaveLength(0);
    expect(parsed.blocks[0]?.text).toContain('Reckonable membership');
    expect(parsed.blocks[0]?.ocr).toBeUndefined();
  });

  /**
   * The mixed document, which is the case the narrow condition is for: a scan
   * stapled into the middle of a text export. Only the scanned page is paid
   * for, and only its chunks are marked.
   */
  it('reads only the page that is a scan', async () => {
    const ocr = new StubOcr();
    const parsed = await pdfHandler.parse({
      content: mixedPdf([
        ['A page with words on it'],
        { width: 8, height: 8 },
        ['And another one'],
      ]),
      ...file,
      ocr,
    });

    expect(ocr.seen.map((page) => page.number)).toEqual([2]);
    expect(parsed.blocks.map((block) => block.ocr)).toEqual([undefined, 'stub', undefined]);
    expect(parsed.blocks[0]?.text).toContain('A page with words on it');
    expect(parsed.blocks[1]?.text).toBe('page 2 says something');
  });

  /**
   * A page that is blank because it is blank.
   *
   * There is no photograph to lift, so there is nothing to send and nothing to
   * pay for — and the page stays the blank the chunker already records as a
   * fact. It is also the honest edge of the trick `page-image.ts` plays: no
   * renderer means no image, no OCR.
   */
  it('sends nothing for an empty page that is not a scan', async () => {
    const ocr = new StubOcr();
    const parsed = await pdfHandler.parse({
      content: pdf([['A page with words on it'], []]),
      ...file,
      ocr,
    });

    expect(ocr.seen).toHaveLength(0);
    expect(parsed.blocks[1]?.text).toBe('');
  });
});

/**
 * The column, which is the point of carrying provenance this far.
 *
 * `WHERE ocr IS NULL` has to mean "text the document actually contained", so
 * the chunker must not lose the mark on its way from a block to a row.
 */
describe('what a chunk says about where its text came from', () => {
  it('carries the engine onto every chunk of an OCR-read page', async () => {
    const parsed = await pdfHandler.parse({
      content: scannedPdf(2),
      ...file,
      ocr: new StubOcr(),
    });

    const chunks = chunk({
      blocks: parsed.blocks,
      mediaType: MediaType.Pdf,
      chunkTokens: 512,
      overlapTokens: 64,
    });

    expect(chunks.map((piece) => piece.ocr)).toEqual(['stub', 'stub']);
  });

  it('leaves it null for text the document carried', async () => {
    const parsed = await pdfHandler.parse({
      content: pdf([['Pay £52,815.08']]),
      ...file,
      ocr: null,
    });

    const chunks = chunk({
      blocks: parsed.blocks,
      mediaType: MediaType.Pdf,
      chunkTokens: 512,
      overlapTokens: 64,
    });

    expect(chunks[0]?.ocr).toBeNull();
  });
});

/**
 * A model in front, and the offline engine for what it missed.
 *
 * The arrangement `INGOT_OCR=openai` with a tessdata directory buys. What
 * matters is that the result is per page: a document can come back part
 * model-read and part Tesseract-read, and the column has to say which for each
 * of them rather than for the deployment.
 */
describe('a fallback behind a model', () => {
  it('asks the second engine only about the pages the first did not read', async () => {
    const model = new StubOcr('model', 20, (page) =>
      page.number === 2 ? null : { text: `model read ${page.number}`, engine: 'model' },
    );
    const behind = new StubOcr('tesseract-eng', 20, (page) => ({
      text: `tesseract read ${page.number}`,
      engine: 'tesseract-eng',
    }));

    const pages = [1, 2, 3].map((number) => ({
      number,
      png: new Uint8Array([137, 80, 78, 71]),
      width: 8,
      height: 8,
    }));

    const read = await new FallbackOcr(model, behind).read(pages);

    expect(behind.seen.map((page) => page.number)).toEqual([2]);
    expect(read.map((found) => found?.text)).toEqual([
      'model read 1',
      'tesseract read 2',
      'model read 3',
    ]);
    // The half of this that ends up in a column, and the reason for it.
    expect(read.map((found) => found?.engine)).toEqual(['model', 'tesseract-eng', 'model']);
  });

  it('does not start the second engine at all when the first read everything', async () => {
    const behind = new StubOcr('tesseract-eng');
    const read = await new FallbackOcr(new StubOcr('model'), behind).read([
      { number: 1, png: new Uint8Array([137]), width: 8, height: 8 },
    ]);

    expect(behind.seen).toHaveLength(0);
    expect(read[0]?.engine).toBe('stub');
  });
});
