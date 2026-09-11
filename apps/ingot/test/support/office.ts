import { zipSync } from 'fflate';

/**
 * Building the Office documents the parser tests read.
 *
 * Fixtures rather than checked-in binaries, for two reasons that both matter
 * here. A `.pptx` in the repository is opaque — nobody reviewing a test can see
 * what it contains, so nobody can tell whether a failing assertion is the
 * parser's fault or the fixture's. And the interesting cases are the *awkward*
 * ones: a deck whose notes do not line up positionally with its slides, one
 * whose parts are numbered past nine, one that claims to expand to a
 * terabyte. None of those are things to go looking for a sample of; they are
 * things to construct exactly.
 *
 * These write real archives with `fflate`, so the parser under test does real
 * unzipping of real OOXML — the same code path a deck from PowerPoint takes.
 * The suite is still offline and still deterministic.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;

/** One slide, its title placeholder, its body paragraphs, and its notes. */
export interface SlideSpec {
  readonly title?: string;
  /** Each becomes its own `<a:p>`, which is what a bullet is. */
  readonly body?: readonly string[];
  readonly notes?: string;
}

/**
 * A `.pptx` as PowerPoint lays one out.
 *
 * The part numbering is the point of doing this properly. Slides are numbered
 * from one in order, but **notes parts are numbered in creation order** — so a
 * deck where only the second and fourth slides have notes gets `notesSlide1`
 * and `notesSlide2`, pointing at slides 2 and 4. That is the shape that catches
 * a parser guessing `notesSlide{N}` for `slide{N}`, and it is exactly what real
 * decks look like once somebody has deleted a slide.
 */
export function pptx(slides: readonly SlideSpec[]): Buffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': encode(CONTENT_TYPES),
  };

  let notesPart = 0;

  slides.forEach((slide, at) => {
    const number = at + 1;
    files[`ppt/slides/slide${number}.xml`] = encode(slideXml(slide));

    if (slide.notes === undefined) {
      // No relationship of that type, which is how a slide with no notes is
      // actually written — not an empty notes part.
      files[`ppt/slides/_rels/slide${number}.xml.rels`] = encode(rels(null));
      return;
    }

    notesPart += 1;
    files[`ppt/notesSlides/notesSlide${notesPart}.xml`] = encode(notesXml(slide.notes));
    files[`ppt/slides/_rels/slide${number}.xml.rels`] = encode(
      rels(`../notesSlides/notesSlide${notesPart}.xml`),
    );
  });

  return Buffer.from(zipSync(files));
}

/** The same, with no `_rels` parts at all — a minimal generator's output. */
export function pptxWithoutRels(slides: readonly SlideSpec[]): Buffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': encode(CONTENT_TYPES),
  };

  slides.forEach((slide, at) => {
    files[`ppt/slides/slide${at + 1}.xml`] = encode(slideXml(slide));
    if (slide.notes !== undefined) {
      files[`ppt/notesSlides/notesSlide${at + 1}.xml`] = encode(notesXml(slide.notes));
    }
  });

  return Buffer.from(zipSync(files));
}

/** A zip that is not a presentation, for the "every Office file is a zip" case. */
export function zipOf(files: Record<string, string>): Buffer {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) encoded[name] = encode(body);
  return Buffer.from(zipSync(encoded));
}

/**
 * An archive whose members compress enormously — the shape of a bomb.
 *
 * Zeroes rather than anything clever: a megabyte of them deflates to a couple
 * of hundred bytes, which is a ratio far past `MAX_RATIO` while holding nothing
 * dangerous. The incompressible padding is what lifts the archive over
 * `RATIO_FLOOR`, so that the ratio check is the one being exercised rather than
 * skipped — without which this fixture would have to declare hundreds of
 * megabytes to trip a different limit, and would cost that much to build.
 */
export function compressible(members: number, bytesEach: number): Buffer {
  const padding = new Uint8Array(8 * 1024);
  for (let at = 0; at < padding.length; at++) padding[at] = (at * 37 + 11) % 251;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': encode(CONTENT_TYPES),
    'ppt/media/image1.bin': padding,
  };
  for (let at = 1; at <= members; at++) {
    files[`ppt/slides/slide${at}.xml`] = new Uint8Array(bytesEach);
  }
  return Buffer.from(zipSync(files));
}

function slideXml(slide: SlideSpec): string {
  const shapes: string[] = [];

  if (slide.title !== undefined) {
    shapes.push(shape(`<p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>`, [slide.title]));
  }
  if (slide.body && slide.body.length > 0) {
    shapes.push(shape(`<p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>`, slide.body));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld>
</p:sld>`;
}

function shape(properties: string, paragraphs: readonly string[]): string {
  const body = paragraphs
    .map((line) => `<a:p><a:r><a:t>${escape(line)}</a:t></a:r></a:p>`)
    .join('');
  return `<p:sp>${properties}<p:txBody>${body}</p:txBody></p:sp>`;
}

function notesXml(notes: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>${escape(notes)}</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`;
}

function rels(notesTarget: string | null): string {
  const relationship = notesTarget
    ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="${notesTarget}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  ${relationship}
</Relationships>`;
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
