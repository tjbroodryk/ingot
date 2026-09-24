import { zlibSync } from 'fflate';

/**
 * Builds the PDFs the parser tests read.
 *
 * Written out rather than checked in, so a reviewer can see what they contain.
 * Real PDFs structurally — a catalogue, a page tree, one uncompressed content
 * stream per page drawing text with `Tj` — read through the same `pdfjs` path a
 * Word export takes.
 */

/** One page, as lines of text drawn down the page. */
export type Page = readonly string[];

/**
 * A PDF with one content stream per page. The cross-reference table records
 * every object's byte offset, so the file is assembled before the table is
 * written — hence a builder rather than a template.
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

    // `Td` moves down the page between lines, which makes `pdfjs` report `hasEOL`.
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
 * `xref` is a table of byte offsets, so it is a second pass once every object
 * is placed.
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
    // A free entry for an unwritten slot, keeping the row count honest against `/Size`.
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

/**
 * A page that is a photograph rather than text: one image, drawn to fill it.
 * `pdfjs` finds no text on one of these, which is what the OCR path is for.
 */
export interface Scan {
  readonly width: number;
  readonly height: number;
}

/** One sheet: lines of text, or a scanned image. */
export type Sheet = Page | Scan;

/** A PDF with no text layer — every page a scan (an image XObject, no `Tj`). */
export function scannedPdf(pages: number, size: Scan = { width: 8, height: 8 }): Buffer {
  return mixedPdf(Array.from({ length: pages }, () => size));
}

/**
 * Text pages and scanned pages in one document — the case the per-page OCR
 * condition is for. Pixels are a flat colour per page; nothing reads them, the
 * test asserts which pages reach the engine.
 */
export function mixedPdf(sheets: readonly Sheet[]): Buffer {
  const objects: string[] = [];
  // 1 catalogue, 2 page tree, 3 font, then three slots a sheet — page, content
  // stream, and an image for the sheets that are scans.
  const pageIds = sheets.map((_unused, at) => 4 + at * 3);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    `<< /Type /Pages /Count ${sheets.length} ` +
    `/Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  sheets.forEach((sheet, at) => {
    const pageId = pageIds[at] as number;
    const streamId = pageId + 1;
    const imageId = pageId + 2;

    if (isScan(sheet)) {
      objects[pageId] =
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${streamId} 0 R >>`;

      // Scale the unit square to the page and paint the image over it.
      const stream = 'q 612 0 0 792 0 0 cm /Im0 Do Q';
      objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

      const pixels = new Uint8Array(sheet.width * sheet.height * 3).fill(16 * (at + 1));
      const deflated = zlibSync(pixels, { level: 6 });
      objects[imageId] =
        `<< /Type /XObject /Subtype /Image /Width ${sheet.width} /Height ${sheet.height} ` +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ' +
        `/Length ${deflated.length} >>\nstream\n${latin1(deflated)}\nendstream`;
      return;
    }

    objects[pageId] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`;

    const drawn = sheet
      .map((line, index) => `${index === 0 ? '' : 'T* '}(${escape(line)}) Tj`)
      .join('\n');
    const stream = `BT /F1 12 Tf 72 720 Td 14 TL\n${drawn}\nET`;
    objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  return assemble(objects, null);
}

function isScan(sheet: Sheet): sheet is Scan {
  return !Array.isArray(sheet);
}

/** Binary, as the `latin1` string `assemble` lays out — one byte per char. */
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}
