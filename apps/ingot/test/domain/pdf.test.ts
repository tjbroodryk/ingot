import { describe, expect, it } from 'bun:test';
import { BlockKind } from '../../src/contexts/files/domain/format.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';
import { pdfHandler } from '../../src/contexts/files/domain/formats/pdf.js';
import { notReallyAPdf, pdf } from '../support/pdf.js';

const read = (content: Buffer, filename = 'report.pdf') =>
  pdfHandler.parse({ content, filename, mediaType: MediaType.Pdf });

describe('reading a PDF', () => {
  it('makes one block per page, and says which page each came from', async () => {
    const parsed = await read(
      pdf([
        ['Deployment Guide', 'Rollout is progressive.'],
        ['Rollback Procedure', 'It takes ninety seconds.'],
        ['Notice Period', 'Thirty days of written notice.'],
      ]),
    );

    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.pages).toBe(3);
    expect(parsed.blocks.map((block) => block.page)).toEqual([1, 2, 3]);
    expect(parsed.blocks[1]?.text).toContain('ninety seconds');
  });

  /** A PDF has no real headings — font size isn't structure — so blocks carry a page and no headings. */
  it('claims no heading structure, because a PDF has none to claim', async () => {
    const parsed = await read(pdf([['LOOKS LIKE A HEADING', 'And some body text.']]));

    expect(parsed.blocks[0]?.headings).toEqual([]);
    expect(parsed.blocks[0]?.kind).toBe(BlockKind.Prose);
    // Not `hard`: a chunk budget can still split a long page.
    expect(parsed.blocks[0]?.hard).toBe(false);
  });

  it('puts the line breaks back', async () => {
    const parsed = await read(pdf([['First line', 'Second line']]));

    expect(parsed.blocks[0]?.text).toBe('First line\nSecond line');
  });

  it('reads a page with nothing on it as an empty block, not a missing one', async () => {
    const parsed = await read(pdf([['Page one.'], [], ['Page three.']]));

    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[1]?.text).toBe('');
    expect(parsed.blocks[2]?.page).toBe(3);
  });

  describe('the title', () => {
    it('takes one the document actually declared', async () => {
      const parsed = await read(pdf([['Body.']], { title: 'The Quarterly Report' }));

      expect(parsed.title).toBe('The Quarterly Report');
    });

    /** Producers often write the source filename into `/Title`; that's a breadcrumb, not a title. */
    it('ignores the breadcrumbs producers leave there', async () => {
      for (const junk of ['Microsoft Word - report.docx', 'Untitled', 'Document1']) {
        expect((await read(pdf([['Body.']], { title: junk }))).title).toBeNull();
      }
    });

    it('is null rather than invented when there is none', async () => {
      expect((await read(pdf([['Body.']]))).title).toBeNull();
    });
  });

  describe('refusing what it cannot read', () => {
    it('refuses a file that starts like a PDF and is not one', async () => {
      await expect(read(notReallyAPdf(), 'broken.pdf')).rejects.toThrow(/broken\.pdf/);
    });

    it('names the file in the refusal, since a worker reports it long after', async () => {
      await expect(read(notReallyAPdf(), 'quarterly-report.pdf')).rejects.toThrow(
        /quarterly-report\.pdf/,
      );
    });
  });

  /** `pdfjs` transfers the input buffer to its worker, detaching it, so the parser must copy first. */
  it('leaves the caller’s buffer intact', async () => {
    const content = pdf([['Body text.']]);
    const before = content.byteLength;

    await read(content);

    expect(content.byteLength).toBe(before);
    expect(content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
