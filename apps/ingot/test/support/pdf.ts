/**
 * Building the PDFs the parser tests read.
 *
 * Written out rather than checked in, for the reason the Office fixtures are: a
 * binary in the repository is opaque, so a reviewer cannot tell whether a
 * failing assertion is the parser's fault or the fixture's. Here it also keeps
 * the suite honest about *what* is being asserted — the text below is visible
 * in the same file as the expectation about it.
 *
 * These are real PDFs, structurally: a catalogue, a page tree, and one
 * uncompressed content stream per page drawing text with `Tj`. `pdfjs` reads
 * them through exactly the code path it reads a Word export through. What they
 * are not is *representative* — a real producer emits compressed streams,
 * subsetted fonts and a text layer whose runs arrive in drawing order rather
 * than reading order. That gap is covered by having run this parser against
 * PDFs from real software; it is not something a fixture can close.
 */

/** One page, as lines of text drawn down the page. */
export type Page = readonly string[];

/**
 * A PDF with one content stream per page.
 *
 * The cross-reference table is the fiddly part and the reason this is a builder
 * rather than a template: every object's byte offset has to be recorded, so the
 * file has to be assembled before the table describing it can be written.
 */
export function pdf(pages: readonly Page[], options: { title?: string } = {}): Buffer {
  const objects: string[] = [];

  // 1 catalogue, 2 page tree, 3 font, then a pair per page.
  const pageIds = pages.map((_, at) => 4 + at * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    `<< /Type /Pages /Count ${pages.length} ` +
    `/Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pages.forEach((lines, at) => {
    const pageId = pageIds[at] as number;
    const streamId = pageId + 1;

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`;

    // `Td` moves down the page between lines, which is what makes `pdfjs`
    // report `hasEOL` and therefore what puts the newlines back.
    const drawn = lines
      .map((line, index) => `${index === 0 ? '' : 'T* '}(${escape(line)}) Tj`)
      .join('\n');
    const stream = `BT /F1 12 Tf 72 720 Td 14 TL\n${drawn}\nET`;

    objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  if (options.title !== undefined) {
    objects[objects.length] = `<< /Title (${escape(options.title)}) >>`;
  }
  const infoId = options.title !== undefined ? objects.length - 1 : null;

  return assemble(objects, infoId);
}

/** A file that starts like a PDF and is not one. */
export function notReallyAPdf(): Buffer {
  return Buffer.from('%PDF-1.7\nthis is not a document\n%%EOF\n');
}

/**
 * Lays the objects out and writes the cross-reference table over the result.
 *
 * `xref` is a table of byte offsets, so it can only be written once every
 * object has been placed — which is why this is a second pass rather than part
 * of building them.
 */
function assemble(objects: readonly string[], infoId: number | null): Buffer {
  let file = '%PDF-1.7\n';
  const offsets: number[] = [];

  for (let id = 1; id < objects.length; id++) {
    const body = objects[id];
    if (body === undefined) continue;

    offsets[id] = Buffer.byteLength(file, 'latin1');
    file += `${id} 0 obj\n${body}\nendobj\n`;
  }

  const start = Buffer.byteLength(file, 'latin1');
  const count = objects.length;

  file += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    const at = offsets[id];
    // A free entry for a slot nothing was written into, which keeps the table's
    // row count honest against the `/Size` below.
    file += at === undefined ? '0000000000 65535 f \n' : `${pad(at)} 00000 n \n`;
  }

  const info = infoId === null ? '' : ` /Info ${infoId} 0 R`;
  file += `trailer\n<< /Size ${count} /Root 1 0 R${info} >>\nstartxref\n${start}\n%%EOF\n`;

  return Buffer.from(file, 'latin1');
}

function pad(offset: number): string {
  return String(offset).padStart(10, '0');
}

function escape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
