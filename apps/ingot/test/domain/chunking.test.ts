import { describe, expect, it } from 'bun:test';
import { ChunkKind } from '@ingot/shared/ingot-v1';
import {
  type Block,
  BlockKind,
} from '../../src/contexts/files/application/ports/document-parser.port.js';
import { Boundary, STRATEGIES, chunk } from '../../src/contexts/files/domain/chunker.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';

/**
 * How a document is cut up, which is the decision this feature lives or dies on.
 *
 * The rule being asserted throughout: **split on the strongest boundary the
 * format actually gives you, and fall back exactly one level at a time.** Every
 * test here is one format's version of that, and the reason they are all in one
 * file is that the *differences* are the interesting part — a strategy is three
 * booleans, and what those booleans buy is only visible side by side.
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
     * The one that would be worst to get wrong, and the easiest to.
     *
     * A slide is a unit somebody authored. Merging two of them produces a chunk
     * that exists in no deck, and a budget-driven splitter merges them
     * constantly, because slides are small.
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
      expect(STRATEGIES[MediaType.Pptx].overlap).toBe(false);
    });
  });

  describe('a document with headings', () => {
    const handbook = [
      block('Everything ships through the pipeline.', { headings: ['2 Deployment'] }),
      block('A rollout is progressive.', { headings: ['2 Deployment', '2.1 Rollout'] }),
      block('Any engineer may roll back.', { headings: ['2 Deployment', '2.2 Rollback'] }),
    ];

    it('splits on the heading rather than on the budget', () => {
      // All three would fit in one chunk twice over. They are still three,
      // because the author already said where the boundaries are.
      const chunks = cut(handbook, MediaType.Markdown);

      expect(chunks).toHaveLength(3);
      expect(chunks.map((piece) => piece.section)).toEqual([
        '2 Deployment',
        '2 Deployment > 2.1 Rollout',
        '2 Deployment > 2.2 Rollback',
      ]);
    });

    /**
     * The single highest-value line in the chunker, asserted directly.
     *
     * A chunk's body is usually the *answer* and its heading is usually the
     * *question's vocabulary* — and they are in different blocks. "Any engineer
     * may roll back" contains no form of the word somebody would search for.
     * Embedding it without "2.2 Rollback" attached throws away the half that
     * makes it findable, and nothing downstream can put it back.
     */
    it('carries the heading path into the text that gets embedded', () => {
      const chunks = cut(handbook, MediaType.Markdown);

      expect(chunks[2]?.text).toContain('2.2 Rollback');
      expect(chunks[2]?.text).toContain('Any engineer may roll back.');
    });

    it('keeps the heading out of a PDF, where headings are guessed', () => {
      // Inferred from font runs rather than declared, so a wrong one poisons
      // the embedding instead of merely failing to help it.
      expect(STRATEGIES[MediaType.Pdf].carryHeadings).toBe(false);
      expect(STRATEGIES[MediaType.Pdf].boundary).toBe(Boundary.Page);

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
      // The two paragraphs of page two are one chunk: a paragraph break inside
      // a page is incidental, and merging across it is what a chunker is for.
      expect(chunks[1]?.text).toContain('second paragraph');
    });

    /**
     * A blank page is a fact, and the only format where that is true.
     *
     * It is how somebody discovers that page 40 came out empty because the OCR
     * failed on it, rather than because nothing was printed there. A blank
     * paragraph run in a Word document is not a fact about anything, and a
     * chunk of it would be an embedding of whitespace sitting in every ranking.
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
      expect(STRATEGIES[MediaType.Text].boundary).toBe(Boundary.Budget);
      expect(STRATEGIES[MediaType.Markdown].boundary).toBe(Boundary.Heading);
      expect(STRATEGIES[MediaType.Pdf].boundary).toBe(Boundary.Page);
      expect(STRATEGIES[MediaType.Pptx].boundary).toBe(Boundary.Page);
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
      // The overlap is real text rather than half a token, which is the whole
      // point of taking it from a boundary: half a word carries no meaning.
      expect(chunks[1]?.text).toMatch(/^word\d+/);
    });
  });

  describe('the knobs a caller may and may not turn', () => {
    /**
     * Which boundary is not a knob, and this is the assertion that says so.
     *
     * There is no case where cutting a deck every 512 tokens beats cutting it
     * every slide, so exposing the choice would be a footgun with no upside.
     * What a caller *can* set is the budget, because that is a function of
     * their embedder and their context window and this service knows neither.
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
      // Not a count of `Body.` alone: a caller budgeting context is handed all
      // of it, so the number they budget against has to describe all of it.
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

      // Ordinals are what `abs(c.ordinal - hit.ordinal) <= 1` expands on, so
      // they have to run continuously over the document rather than per group.
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
      // No overlap: repeating half a record into the next chunk is duplication
      // that ranks against nothing.
      expect(STRATEGIES[MediaType.Csv].overlap).toBe(false);
    });
  });
});
