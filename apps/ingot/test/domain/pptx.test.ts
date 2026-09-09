import { describe, expect, it } from 'bun:test';
import { BlockKind } from '../../src/contexts/files/application/ports/document-parser.port.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';
import { PptxParser } from '../../src/contexts/files/infrastructure/parsers/pptx-parser.js';
import { byNumber } from '../../src/contexts/files/infrastructure/parsers/office-zip.js';
import { compressible, pptx, pptxWithoutRels, zipOf } from '../support/office.js';

const parser = new PptxParser();
const read = (content: Buffer) =>
  parser.parse({ content, filename: 'deck.pptx', mediaType: MediaType.Pptx });

describe('reading a PowerPoint deck', () => {
  it('makes exactly one block per slide, marked so nothing may merge them', async () => {
    const parsed = await read(
      pptx([{ title: 'Q3 pricing' }, { title: 'Up 4%' }, { title: 'Questions?' }]),
    );

    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.pages).toBe(3);
    for (const block of parsed.blocks) {
      // `hard` is what stops a budget-driven pass merging three small slides
      // into a chunk that exists in no deck.
      expect(block.hard).toBe(true);
      expect(block.kind).toBe(BlockKind.Slide);
    }
    expect(parsed.blocks.map((block) => block.page)).toEqual([1, 2, 3]);
  });

  /**
   * The title is what makes a slide findable, and it is in a different shape
   * from the words that answer the question.
   *
   * A body reading "Up 4% year on year" ranks against nothing anybody would
   * type. Promoting the title to a heading is what lets `carryHeadings` put
   * "Q3 revenue" at the top of the embedded text.
   */
  it('promotes the title placeholder to the heading, and keeps it out of the body', async () => {
    const parsed = await read(
      pptx([{ title: 'Q3 revenue', body: ['Up 4% year on year', 'Costs flat'] }]),
    );

    expect(parsed.blocks[0]?.headings).toEqual(['Q3 revenue']);
    expect(parsed.blocks[0]?.text).not.toContain('Q3 revenue');
    expect(parsed.blocks[0]?.text).toContain('Up 4% year on year');
  });

  /**
   * A bulleted list is separate `<a:p>` elements with no whitespace between
   * them in the markup, so concatenating the runs gives "Up 4%Costs flat" —
   * one nonsense token where there were two real lines, and the embedding pays.
   */
  it('keeps bullets on separate lines', async () => {
    const parsed = await read(pptx([{ title: 'T', body: ['Up 4%', 'Costs flat'] }]));

    expect(parsed.blocks[0]?.text).toBe('Up 4%\nCosts flat');
  });

  describe('speaker notes', () => {
    it('brings them onto the slide, marked as what they are', async () => {
      const parsed = await read(
        pptx([{ title: 'Q3 revenue', body: ['Up 4%'], notes: 'Because the price rise landed' }]),
      );

      // Usually the sentence the slide is missing, and in a different part of
      // the archive — so nothing else would ever bring the two together.
      expect(parsed.blocks[0]?.text).toContain('Up 4%');
      expect(parsed.blocks[0]?.text).toContain('Speaker notes: Because the price rise landed');
    });

    /**
     * The bug this test exists for, and it very nearly shipped.
     *
     * Notes parts are numbered in **creation order**, not slide order. A deck
     * where only slides 2 and 4 have notes gets `notesSlide1` and
     * `notesSlide2` — so guessing `notesSlide{N}` for `slide{N}` staples slide
     * 4's notes onto slide 2 and finds nothing for slide 4. That text is then
     * chunked, embedded and returned as though somebody said it about the wrong
     * slide, and nothing anywhere reports a problem.
     */
    it('follows the relationship rather than guessing at the number', async () => {
      const parsed = await read(
        pptx([
          { title: 'One' },
          { title: 'Two', notes: 'notes belonging to two' },
          { title: 'Three' },
          { title: 'Four', notes: 'notes belonging to four' },
        ]),
      );

      expect(parsed.blocks[0]?.text).not.toContain('Speaker notes');
      expect(parsed.blocks[1]?.text).toContain('notes belonging to two');
      expect(parsed.blocks[2]?.text).not.toContain('Speaker notes');
      expect(parsed.blocks[3]?.text).toContain('notes belonging to four');
    });

    it('falls back to the positional guess when a deck has no relationships', async () => {
      // Some minimal generators omit `_rels` entirely. The guess is the only
      // thing left to try there, and it is right whenever every slide has notes.
      const parsed = await read(
        pptxWithoutRels([{ title: 'One', notes: 'first' }, { title: 'Two', notes: 'second' }]),
      );

      expect(parsed.blocks[0]?.text).toContain('first');
      expect(parsed.blocks[1]?.text).toContain('second');
    });

    it('reads an empty notes part as no notes', async () => {
      // Real decks are full of these: PowerPoint writes a notes part holding
      // only the slide-number field for slides nobody typed a note on.
      const parsed = await read(pptx([{ title: 'One', notes: '   ' }]));

      expect(parsed.blocks[0]?.text).not.toContain('Speaker notes');
    });
  });

  /**
   * Found by running this against a real thirteen-slide deck, whose parts came
   * back `slide1, slide10, slide11, slide12, slide13, slide2, …`.
   *
   * A lexical sort would have numbered them in an order nobody's deck is in,
   * and nothing downstream could have noticed: every chunk would look perfectly
   * well-formed. `ordinal` is what neighbour expansion joins on, so the order
   * has to be the deck's own.
   */
  it('orders slides numerically, not lexically', async () => {
    expect(
      byNumber(['ppt/slides/slide10.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide1.xml']),
    ).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide10.xml']);

    const parsed = await read(
      pptx(Array.from({ length: 12 }, (_, at) => ({ title: `Slide ${at + 1}` }))),
    );

    expect(parsed.blocks.map((block) => block.headings[0])).toEqual(
      Array.from({ length: 12 }, (_, at) => `Slide ${at + 1}`),
    );
  });

  it('decodes escaped text rather than storing the markup', async () => {
    const parsed = await read(pptx([{ title: 'R&D', body: ['a < b & c > d'] }]));

    expect(parsed.blocks[0]?.headings).toEqual(['R&D']);
    expect(parsed.blocks[0]?.text).toBe('a < b & c > d');
  });

  describe('refusing what it should not read', () => {
    it('refuses a zip that is not a presentation', async () => {
      // Every OOXML format is a zip, so the extension is the only thing telling
      // them apart until exactly this point.
      await expect(read(zipOf({ 'word/document.xml': '<w:document/>' }))).rejects.toThrow(
        /no slides in it/,
      );
    });

    /**
     * The one that matters most, and the reason the limits are checked against
     * the archive's own central directory before anything is inflated.
     *
     * A small archive that honestly declares an enormous expansion is refused
     * on its own account of itself — at no cost, and without a decompressor
     * ever being pointed at it.
     */
    it('refuses an archive that claims to expand absurdly', async () => {
      const bomb = compressible(8, 1024 * 1024);

      // The fixture really is small and really does claim 8 MiB — a ratio far
      // past anything honest, which is the signal being tested rather than the
      // absolute size. It is refused before a byte of it is inflated.
      expect(bomb.byteLength).toBeLessThan(32 * 1024);
      await expect(read(bomb)).rejects.toThrow(/expand/i);
    });

    it('refuses an archive with an implausible number of parts', async () => {
      await expect(read(compressible(2_500, 8))).rejects.toThrow(/parts in it/);
    });
  });
});
