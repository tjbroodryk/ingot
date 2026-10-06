import { describe, expect, it } from 'bun:test';
import { BlockKind } from '../../src/contexts/files/domain/format.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';
import { docxHandler } from '../../src/contexts/files/domain/formats/docx.js';
import { compressible, docx, docxWithTitle, zipOf } from '../support/office.js';

const read = (content: Buffer) =>
  docxHandler.parse({ content, filename: 'doc.docx', mediaType: MediaType.Docx });

describe('reading a Word document', () => {
  it('groups paragraphs under their heading', async () => {
    const parsed = await read(
      docx([
        { heading: { level: 1, text: 'Introduction' }, paragraphs: ['First paragraph.', 'Second paragraph.'] },
        { heading: { level: 1, text: 'Conclusion' }, paragraphs: ['Final thoughts.'] },
      ]),
    );

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]?.headings).toEqual(['Introduction']);
    expect(parsed.blocks[0]?.text).toBe('First paragraph.\n\nSecond paragraph.');
    expect(parsed.blocks[1]?.headings).toEqual(['Conclusion']);
    expect(parsed.blocks[1]?.text).toBe('Final thoughts.');
  });

  it('preserves heading hierarchy', async () => {
    const parsed = await read(
      docx([
        { heading: { level: 1, text: 'Chapter 1' } },
        { heading: { level: 2, text: 'Section 1.1' }, paragraphs: ['Content under 1.1.'] },
        { heading: { level: 2, text: 'Section 1.2' }, paragraphs: ['Content under 1.2.'] },
        { heading: { level: 1, text: 'Chapter 2' }, paragraphs: ['Content under Chapter 2.'] },
      ]),
    );

    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[0]?.headings).toEqual(['Chapter 1', 'Section 1.1']);
    expect(parsed.blocks[1]?.headings).toEqual(['Chapter 1', 'Section 1.2']);
    expect(parsed.blocks[2]?.headings).toEqual(['Chapter 2']);
  });

  it('keeps paragraphs separate within a section', async () => {
    const parsed = await read(
      docx([{ paragraphs: ['Line one.', 'Line two.', 'Line three.'] }]),
    );

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.text).toBe('Line one.\n\nLine two.\n\nLine three.');
  });

  it('handles documents with no headings', async () => {
    const parsed = await read(
      docx([{ paragraphs: ['Just some text.', 'And some more.'] }]),
    );

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.headings).toEqual([]);
    expect(parsed.blocks[0]?.text).toBe('Just some text.\n\nAnd some more.');
  });

  it('marks all blocks as prose, not hard boundaries', async () => {
    const parsed = await read(
      docx([
        { heading: { level: 1, text: 'One' }, paragraphs: ['Text.'] },
        { heading: { level: 1, text: 'Two' }, paragraphs: ['More.'] },
      ]),
    );

    for (const block of parsed.blocks) {
      expect(block.hard).toBe(false);
      expect(block.kind).toBe(BlockKind.Prose);
    }
  });

  it('has no page numbers (documents are continuous)', async () => {
    const parsed = await read(
      docx([{ heading: { level: 1, text: 'Title' }, paragraphs: ['Body.'] }]),
    );

    expect(parsed.pages).toBeNull();
    expect(parsed.blocks[0]?.page).toBeNull();
  });

  describe('title extraction', () => {
    it('uses metadata title when present', async () => {
      const parsed = await read(
        docxWithTitle([{ paragraphs: ['Body text.'] }], 'Document Title'),
      );

      expect(parsed.title).toBe('Document Title');
    });

    it('falls back to first heading when no metadata', async () => {
      const parsed = await read(
        docx([
          { heading: { level: 1, text: 'First Heading' }, paragraphs: ['Text.'] },
          { heading: { level: 1, text: 'Second Heading' }, paragraphs: ['More.'] },
        ]),
      );

      expect(parsed.title).toBe('First Heading');
    });

    it('returns null when no title or headings', async () => {
      const parsed = await read(docx([{ paragraphs: ['Just text.'] }]));

      expect(parsed.title).toBeNull();
    });
  });

  it('decodes escaped text rather than storing the markup', async () => {
    const parsed = await read(
      docx([{ heading: { level: 1, text: 'R&D' }, paragraphs: ['a < b & c > d'] }]),
    );

    expect(parsed.blocks[0]?.headings).toEqual(['R&D']);
    expect(parsed.blocks[0]?.text).toBe('a < b & c > d');
  });

  describe('refusing what it should not read', () => {
    it('refuses a zip that is not a Word document', async () => {
      await expect(read(zipOf({ 'ppt/slides/slide1.xml': '<p:sld/>' }))).rejects.toThrow(
        /no document\.xml in it/,
      );
    });

    it('refuses an archive that claims to expand absurdly', async () => {
      const bomb = compressible(8, 1024 * 1024);

      expect(bomb.byteLength).toBeLessThan(32 * 1024);
      await expect(read(bomb)).rejects.toThrow(/expand/i);
    });

    it('refuses an archive with an implausible number of parts', async () => {
      await expect(read(compressible(2_500, 8))).rejects.toThrow(/parts in it/);
    });
  });
});
