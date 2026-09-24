import { describe, expect, it } from 'bun:test';
import { ChunkKind } from '@ingot/shared/ingot-v1';
import { type Block, BlockKind, Boundary } from '../../src/contexts/files/domain/format.js';
import { chunk } from '../../src/contexts/files/domain/chunker.js';
import { FORMATS } from '../../src/contexts/files/domain/formats/index.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';

/**
 * How a document is cut up. The rule throughout: split on the strongest boundary
 * the format gives, and fall back one level at a time. Each test is one format's
 * version of that.
 */
describe('chunking', () => {
  const block = (text: string, over: Partial<Block> = {}): Block => ({
    text,
    page: null,
    headings: [],
    hard: false,
    kind: BlockKind.Prose,
    ...over,
  });

  const cut = (blocks: readonly Block[], mediaType: MediaType, tokens = 512, overlap = 64) =>
    chunk({ blocks, mediaType, chunkTokens: tokens, overlapTokens: overlap });

  describe('a slide deck', () => {
    /**
     * A slide is a unit somebody authored; merging two produces a chunk that
     * exists in no deck, and a budget splitter would merge them since they're small.
     */
    it('never merges two slides, however small they are', () => {
      const slides = ['Q3 pricing', 'Up 4%', 'Questions?'].map((text) =>
        block(text, { hard: true, page: 1, kind: BlockKind.Slide }),
      );

      const chunks = cut(slides, MediaType.Pptx);

      expect(chunks).toHaveLength(3);
      expect(chunks.map((piece) => piece.kind)).toEqual([
        ChunkKind.Slide,
        ChunkKind.Slide,
        ChunkKind.Slide,
      ]);
    });

    it('does not repeat the previous slide, because a slide does not continue', () => {
      const slides = ['first slide entirely', 'second slide entirely'].map((text) =>
        block(text, { hard: true, kind: BlockKind.Slide }),
      );

      const chunks = cut(slides, MediaType.Pptx, 512, 128);

      expect(chunks[1]?.text).not.toContain('first slide');
      expect(FORMATS[MediaType.Pptx].chunking.overlap).toBe(false);
    });
  });

  describe('a document with headings', () => {
    const handbook = [
      block('Everything ships through the pipeline.', { headings: ['2 Deployment'] }),
      block('A rollout is progressive.', { headings: ['2 Deployment', '2.1 Rollout'] }),
      block('Any engineer may roll back.', { headings: ['2 Deployment', '2.2 Rollback'] }),
    ];

    it('splits on the heading rather than on the budget', () => {
      // All three would fit in one chunk, but the author drew the boundaries.
      const chunks = cut(handbook, MediaType.Markdown);

      expect(chunks).toHaveLength(3);
      expect(chunks.map((piece) => piece.section)).toEqual([
        '2 Deployment',
        '2 Deployment > 2.1 Rollout',
        '2 Deployment > 2.2 Rollback',
      ]);
    });

    /**
     * A chunk's body is the answer and its heading the question's vocabulary,
     * and they are in different blocks. Embedding "Any engineer may roll back"
     * without "2.2 Rollback" throws away the half that makes it findable.
     */
    it('carries the heading path into the text that gets embedded', () => {
      const chunks = cut(handbook, MediaType.Markdown);

      expect(chunks[2]?.text).toContain('2.2 Rollback');
      expect(chunks[2]?.text).toContain('Any engineer may roll back.');
    });

    it('keeps the heading out of a PDF, where headings are guessed', () => {
      // A PDF's headings are guessed from font runs, so a wrong one poisons the
      // embedding rather than merely failing to help.
      expect(FORMATS[MediaType.Pdf].chunking.carryHeadings).toBe(false);
      expect(FORMATS[MediaType.Pdf].chunking.boundary).toBe(Boundary.Page);

      const chunks = cut(
        [block('Body text.', { headings: ['Probably A Heading'], page: 1 })],
        MediaType.Pdf,
      );
      expect(chunks[0]?.text).toBe('Body text.');
    });
  });

  describe('a PDF', () => {
    it('splits on the page, and records which page a chunk came from', () => {
      const pages = [
        block('Page one text.', { page: 1 }),
        block('Page two text.', { page: 2 }),
        block('Page two, second paragraph.', { page: 2 }),
      ];

      const chunks = cut(pages, MediaType.Pdf);

      expect(chunks).toHaveLength(2);
      expect(chunks.map((piece) => piece.page)).toEqual([1, 2]);
      // Page two's two paragraphs are one chunk: a break inside a page is incidental.
      expect(chunks[1]?.text).toContain('second paragraph');
    });

    /**
     * A blank page is a fact — how somebody finds page 40 came out empty because
     * OCR failed. A blank paragraph run in a Word document is not, so it's dropped.
     */
    it('keeps an empty page, and drops an empty paragraph run', () => {
      const withBlankPage = cut(
        [block('Text.', { page: 1 }), block('   ', { page: 2 })],
        MediaType.Pdf,
      );
      expect(withBlankPage).toHaveLength(2);
      expect(withBlankPage[1]?.page).toBe(2);

      const withBlankRun = cut([block('Text.'), block('   ')], MediaType.Markdown);
      expect(withBlankRun).toHaveLength(1);
    });
  });

  describe('the token window, which is the fallback and never the default', () => {
    it('is what plain text gets, and only plain text among the prose formats', () => {
      expect(FORMATS[MediaType.Text].chunking.boundary).toBe(Boundary.Budget);
      expect(FORMATS[MediaType.Markdown].chunking.boundary).toBe(Boundary.Heading);
      expect(FORMATS[MediaType.Pdf].chunking.boundary).toBe(Boundary.Page);
      expect(FORMATS[MediaType.Pptx].chunking.boundary).toBe(Boundary.Page);
    });

    it('breaks an oversized block on paragraphs before it breaks it anywhere else', () => {
      const paragraphs = Array.from({ length: 6 }, (_, at) => `Paragraph ${at} ${'x'.repeat(200)}`);
      const chunks = cut([block(paragraphs.join('\n\n'))], MediaType.Text, 64);

      expect(chunks.length).toBeGreaterThan(1);
      // Every piece is a whole paragraph: none was cut through the middle.
      for (const piece of chunks) expect(piece.text).toMatch(/Paragraph \d/);
    });

    it('falls back to sentences when there are no paragraphs to use', () => {
      const sentences = Array.from(
        { length: 8 },
        (_, at) => `This is sentence number ${at} and it runs on for a while.`,
      ).join(' ');

      const chunks = cut([block(sentences)], MediaType.Text, 32, 0);

      expect(chunks.length).toBeGreaterThan(1);
      // Nothing was cut mid-word, which is what the sentence level buys.
      for (const piece of chunks) expect(piece.text).toMatch(/\.$|^\S/);
    });

    it('still cuts an unpunctuated wall, because a bad text layer produces one', () => {
      const wall = 'x'.repeat(4000);
      const chunks = cut([block(wall)], MediaType.Text, 64, 0);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((piece) => piece.text).join('')).toBe(wall);
    });

    it('repeats the tail of the previous chunk, from a word boundary', () => {
      const words = Array.from({ length: 200 }, (_, at) => `word${at}`).join(' ');
      const chunks = cut([block(words)], MediaType.Text, 32, 8);

      expect(chunks.length).toBeGreaterThan(1);
      // The overlap is real text from a word boundary, not half a token.
      expect(chunks[1]?.text).toMatch(/^word\d+/);
    });
  });

  describe('the knobs a caller may and may not turn', () => {
    /**
     * The boundary is not a knob: cutting a deck every 512 tokens never beats
     * cutting it every slide. The budget is a knob, because it depends on the
     * caller's embedder and context window.
     */
    it('honours the budget without letting it override a format boundary', () => {
      const slides = Array.from({ length: 4 }, () =>
        block('tiny', { hard: true, kind: BlockKind.Slide }),
      );

      // A budget vastly larger than the whole deck still yields four chunks.
      expect(cut(slides, MediaType.Pptx, 4096)).toHaveLength(4);
    });

    it('counts the tokens of what is actually stored, heading and overlap included', () => {
      const chunks = cut([block('Body.', { headings: ['A Heading'] })], MediaType.Markdown);

      expect(chunks[0]?.text).toBe('A Heading\n\nBody.');
      // Not `Body.` alone: the caller is handed all of it, so the count covers all.
      expect(chunks[0]?.tokens).toBeGreaterThan(2);
    });

    it('numbers chunks from zero, across every group', () => {
      const chunks = cut(
        [
          block('One.', { page: 1 }),
          block('Two.', { page: 2 }),
          block('Three.', { page: 3 }),
        ],
        MediaType.Pdf,
      );

      // `abs(c.ordinal - hit.ordinal) <= 1` expands on ordinals, so they run
      // continuously over the document, not per group.
      expect(chunks.map((piece) => piece.ordinal)).toEqual([0, 1, 2]);
    });
  });

  describe('a spreadsheet', () => {
    it('gets row chunks rather than prose ones', () => {
      const rows = [
        block('invoice_no: ACME-4471\nvendor: Acme', { kind: BlockKind.Table }),
        block('invoice_no: BOLT-0012\nvendor: Bolt', { kind: BlockKind.Table }),
      ];

      const chunks = cut(rows, MediaType.Csv);

      expect(chunks[0]?.kind).toBe(ChunkKind.Table);
      // No overlap: half a record repeated into the next chunk ranks against nothing.
      expect(FORMATS[MediaType.Csv].chunking.overlap).toBe(false);
    });
  });
});
