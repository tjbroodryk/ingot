import { describe, expect, it } from 'bun:test';
import { BlockKind } from '../../src/contexts/files/domain/format.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';
import { pptxHandler } from '../../src/contexts/files/domain/formats/pptx.js';
import { byNumber } from '../../src/contexts/files/domain/formats/office-zip.js';
import { compressible, pptx, pptxWithoutRels, zipOf } from '../support/office.js';

const read = (content: Buffer) =>
  pptxHandler.parse({ content, filename: 'deck.pptx', mediaType: MediaType.Pptx });

describe('reading a PowerPoint deck', () => {
  it('makes exactly one block per slide, marked so nothing may merge them', async () => {
    const parsed = await read(
      pptx([{ title: 'Q3 pricing' }, { title: 'Up 4%' }, { title: 'Questions?' }]),
    );

    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.pages).toBe(3);
    for (const block of parsed.blocks) {
      // `hard` stops a budget pass from merging small slides.
      expect(block.hard).toBe(true);
      expect(block.kind).toBe(BlockKind.Slide);
    }
    expect(parsed.blocks.map((block) => block.page)).toEqual([1, 2, 3]);
  });

  /** The title is promoted to a heading so `carryHeadings` puts it atop the embedded text. */
  it('promotes the title placeholder to the heading, and keeps it out of the body', async () => {
    const parsed = await read(
      pptx([{ title: 'Q3 revenue', body: ['Up 4% year on year', 'Costs flat'] }]),
    );

    expect(parsed.blocks[0]?.headings).toEqual(['Q3 revenue']);
    expect(parsed.blocks[0]?.text).not.toContain('Q3 revenue');
    expect(parsed.blocks[0]?.text).toContain('Up 4% year on year');
  });

  /** Bullets are separate `<a:p>` elements with no whitespace, so runs are joined with newlines. */
  it('keeps bullets on separate lines', async () => {
    const parsed = await read(pptx([{ title: 'T', body: ['Up 4%', 'Costs flat'] }]));

    expect(parsed.blocks[0]?.text).toBe('Up 4%\nCosts flat');
  });

  describe('speaker notes', () => {
    it('brings them onto the slide, marked as what they are', async () => {
      const parsed = await read(
        pptx([{ title: 'Q3 revenue', body: ['Up 4%'], notes: 'Because the price rise landed' }]),
      );

      expect(parsed.blocks[0]?.text).toContain('Up 4%');
      expect(parsed.blocks[0]?.text).toContain('Speaker notes: Because the price rise landed');
    });

    /** Notes parts are numbered in creation order, not slide order, so guessing `notesSlide{N}` misattributes them. */
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
      // Some generators omit `_rels`; the positional guess is all that's left.
      const parsed = await read(
        pptxWithoutRels([{ title: 'One', notes: 'first' }, { title: 'Two', notes: 'second' }]),
      );

      expect(parsed.blocks[0]?.text).toContain('first');
      expect(parsed.blocks[1]?.text).toContain('second');
    });

    it('reads an empty notes part as no notes', async () => {
      // PowerPoint writes a notes part with only the slide-number field when there's no note.
      const parsed = await read(pptx([{ title: 'One', notes: '   ' }]));

      expect(parsed.blocks[0]?.text).not.toContain('Speaker notes');
    });
  });

  /** Slide parts sort numerically, not lexically (`slide10` after `slide2`); `ordinal` joins on that order. */
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
      // Every OOXML format is a zip; the extension is all that tells them apart until here.
      await expect(read(zipOf({ 'word/document.xml': '<w:document/>' }))).rejects.toThrow(
        /no slides in it/,
      );
    });

    /** Refused from the central directory's declared expansion, before anything is inflated. */
    it('refuses an archive that claims to expand absurdly', async () => {
      const bomb = compressible(8, 1024 * 1024);

      // Small archive declaring 8 MiB — the ratio is the signal, not the absolute size.
      expect(bomb.byteLength).toBeLessThan(32 * 1024);
      await expect(read(bomb)).rejects.toThrow(/expand/i);
    });

    it('refuses an archive with an implausible number of parts', async () => {
      await expect(read(compressible(2_500, 8))).rejects.toThrow(/parts in it/);
    });
  });
});
