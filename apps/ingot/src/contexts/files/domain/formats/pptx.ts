import { InvariantViolation } from '../../../../shared/domain/index.js';
import {
  type Block,
  BlockKind,
  Boundary,
  ByteShape,
  type FormatHandler,
  type ParseInput,
  type ParsedDocument,
} from '../format.js';
import { MediaType } from '../media-type.js';
import { byNumber, readParts } from './office-zip.js';
import { elementText, textOf } from './xml-text.js';

const SLIDE = /^ppt\/slides\/slide\d+\.xml$/;
const NOTES = /^ppt\/notesSlides\/notesSlide\d+\.xml$/;
const RELS = /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/;
const CORE = 'docProps/core.xml';

/** The relationship that points a slide at its speaker notes. */
const NOTES_REL =
  /<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"|<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/notesSlide"/;

/**
 * A shape on a slide. Split on the closing `</p:sp>` rather than matching
 * balanced elements, which is safe since `<p:sp>` does not nest.
 */
const SHAPE = /<p:sp(?:\s[^>]*)?>([\s\S]*?)<\/p:sp>/g;

/** A title placeholder. `ctrTitle` is the big centred one on a section slide. */
const TITLE_ROLE = /<p:ph[^>]*type="(?:ctrTitle|title)"/;

/**
 * A PowerPoint deck, read as one chunk per slide.
 *
 * A slide is an authored unit, so every block is `hard` and
 * `Boundary.Page` keeps it whole. The title becomes the heading, speaker notes
 * join the slide, and paragraphs are kept apart.
 */
export const pptxHandler: FormatHandler = {
  mediaType: MediaType.Pptx,
  extensions: ['pptx'],
  shape: ByteShape.Zip,
  tabular: false,
  // One slide, one chunk; never merged and nothing to overlap.
  chunking: { boundary: Boundary.Page, overlap: false, carryHeadings: true },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const parts = readParts(
      input.content,
      (name) => SLIDE.test(name) || NOTES.test(name) || RELS.test(name) || name === CORE,
    );

    // Numerically, never lexically: `slide10` must not sort before `slide2`.
    const slides = byNumber([...parts.keys()].filter((name) => SLIDE.test(name)));

    if (slides.length === 0) {
      throw new InvariantViolation(
        `"${input.filename}" is a zip archive but has no slides in it. It may be a .docx or ` +
          '.xlsx that was sent as a presentation — every Office format is a zip, so the ' +
          'extension is the only thing that distinguishes them until this point.',
      );
    }

    const blocks = slides.map((name, at) => slideBlock(parts, name, at + 1));

    return {
      blocks,
      pages: slides.length,
      // The deck's declared title, else the first slide's. Never invented.
      title: declaredTitle(parts) ?? blocks[0]?.headings[0] ?? null,
      rows: null,
    };
  },
};

function slideBlock(parts: Map<string, string>, name: string, number: number): Block {
  const xml = parts.get(name) ?? '';
  const title = titleOf(xml);
  const body = bodyOf(xml, title);
  const notes = notesFor(parts, name);

  const spoken = notes ? textOf(notes).trim() : '';

  return {
    // Notes are marked, not run together with the body.
    text: [body, spoken.length > 0 ? `Speaker notes: ${spoken}` : '']
      .filter((part) => part.length > 0)
      .join('\n\n'),
    page: number,
    headings: title ? [title] : [],
    // Never merged with the slide beside it, whatever the budget says.
    hard: true,
    kind: BlockKind.Slide,
  };
}

/**
 * A slide's speaker notes, via `slideN.xml.rels`.
 *
 * The parts are numbered by creation order, not slide order, so a positional
 * guess would staple the wrong notes to a slide. That guess survives only as a
 * fallback for a deck with no rels part.
 */
function notesFor(parts: Map<string, string>, slide: string): string | undefined {
  const rels = parts.get(`${slide.replace('ppt/slides/', 'ppt/slides/_rels/')}.rels`);

  if (rels) {
    const found = NOTES_REL.exec(rels);
    const target = found?.[1] ?? found?.[2];
    // No relationship of that type: the slide has no notes.
    if (!target) return undefined;
    return parts.get(resolve(target));
  }

  return parts.get(slide.replace('ppt/slides/slide', 'ppt/notesSlides/notesSlide'));
}

/** The title placeholder's text, if the layout marked a shape as one. */
function titleOf(xml: string): string | null {
  for (const shape of xml.matchAll(SHAPE)) {
    const body = shape[1] ?? '';
    if (TITLE_ROLE.test(body)) {
      const text = textOf(body).trim();
      if (text.length > 0) return text.replace(/\s*\n\s*/g, ' ');
    }
  }
  return null;
}

/**
 * Everything on the slide except the title, read shape by shape so two text
 * boxes do not run into each other.
 */
function bodyOf(xml: string, title: string | null): string {
  const parts: string[] = [];

  for (const shape of xml.matchAll(SHAPE)) {
    const body = shape[1] ?? '';
    if (TITLE_ROLE.test(body)) continue;

    const text = textOf(body).trim();
    if (text.length > 0) parts.push(text);
  }

  // Fall back to the whole slide for text outside any `<p:sp>`.
  if (parts.length === 0) {
    const whole = textOf(xml).trim();
    return title ? whole.replace(title, '').trim() : whole;
  }
  return parts.join('\n\n');
}

/** The deck's declared title, often absent. */
function declaredTitle(parts: Map<string, string>): string | null {
  const core = parts.get(CORE);
  return core ? elementText(core, 'title') : null;
}

/**
 * A relative relationship target, resolved against `ppt/slides/`. Segments that
 * climb above the root are dropped; these names only key into a map.
 */
function resolve(target: string): string {
  const segments = 'ppt/slides'.split('/');

  for (const step of target.split('/')) {
    if (step === '' || step === '.') continue;
    if (step === '..') segments.pop();
    else segments.push(step);
  }
  return segments.join('/');
}
