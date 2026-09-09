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

  /**
   * The claim this parser deliberately does *not* make.
   *
   * A PDF has no headings — what looks like one is a font size, and inferring a
   * hierarchy from font runs is a guess wrong often enough to poison an
   * embedding rather than help it. So the blocks carry a real page and no
   * headings at all, and `STRATEGIES` sets `carryHeadings: false` to match.
   * This is a smaller claim than the Markdown parser makes and it is the true
   * one.
   */
  it('claims no heading structure, because a PDF has none to claim', async () => {
    const parsed = await read(pdf([['LOOKS LIKE A HEADING', 'And some body text.']]));

    expect(parsed.blocks[0]?.headings).toEqual([]);
    expect(parsed.blocks[0]?.kind).toBe(BlockKind.Prose);
    // Not `hard`: the page boundary comes from the strategy, so a caller's
    // chunk budget can still split a very long page.
    expect(parsed.blocks[0]?.hard).toBe(false);
  });

  it('puts the line breaks back', async () => {
    const parsed = await read(pdf([['First line', 'Second line']]));

    expect(parsed.blocks[0]?.text).toBe('First line\nSecond line');
  });

  it('reads a page with nothing on it as an empty block, not a missing one', async () => {
    // A blank page in a scan is a fact worth keeping — it is how somebody finds
    // out that page 2 came out empty because the OCR failed on it.
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

    /**
     * Producers write the source filename into `/Title` constantly.
     *
     * `Microsoft Word - report.docx` is not a title, it is a breadcrumb — and
     * embedding it would rank this document against every other one exported
     * the same way, which is a great many of them.
     */
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
      // The caller is gone by the time this runs, so the message lands in
      // `ingot_files.error` and is the only thing they will ever see about it.
      await expect(read(notReallyAPdf(), 'quarterly-report.pdf')).rejects.toThrow(
        /quarterly-report\.pdf/,
      );
    });
  });

  /**
   * The buffer is the caller's, and `pdfjs` takes ownership of what it is given.
   *
   * It transfers the array away to its worker, which leaves the original
   * detached — and the same bytes are wanted afterwards for the sha256 and for
   * a re-parse. Copying is one line and the bug it prevents is a zero-length
   * hash on every PDF, which nothing would have reported.
   */
  it('leaves the caller’s buffer intact', async () => {
    const content = pdf([['Body text.']]);
    const before = content.byteLength;

    await read(content);

    expect(content.byteLength).toBe(before);
    expect(content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
