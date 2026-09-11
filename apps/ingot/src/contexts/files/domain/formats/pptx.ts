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
 * A shape on a slide, with the placeholder role the layout gave it.
 *
 * `<p:sp>` is the element; the role is on a `<p:ph type="…">` inside its
 * non-visual properties. Splitting on the closing tag rather than matching
 * balanced elements is safe here because `<p:sp>` does not nest inside itself
 * in any slide any tool produces.
 */
const SHAPE = /<p:sp(?:\s[^>]*)?>([\s\S]*?)<\/p:sp>/g;

/** A title placeholder. `ctrTitle` is the big centred one on a section slide. */
const TITLE_ROLE = /<p:ph[^>]*type="(?:ctrTitle|title)"/;

/**
 * A PowerPoint deck, read as one chunk per slide.
 *
 * **A slide is the easiest structural boundary in any format and the one it
 * would be worst to ignore.** It is a unit somebody deliberately authored:
 * merging two produces a chunk that exists in no deck, and splitting one
 * produces half an argument. Because slides are small, a budget-driven splitter
 * merges them constantly — which is exactly why `STRATEGIES` gives this format
 * `Boundary.Page` with no overlap, and why every block here is `hard`.
 *
 * Three decisions inside a slide are worth stating, because they are what makes
 * the chunk worth embedding rather than merely correct:
 *
 * - **The title becomes the heading**, so `carryHeadings` puts it at the top of
 *   the embedded text. A slide body reading "Up 4% year on year" ranks against
 *   nothing anybody would type; with "Q3 revenue" attached it ranks against the
 *   question actually being asked.
 * - **Speaker notes join the slide.** They are usually the sentence the slide
 *   is missing — the deck says "Up 4%" and the notes say why — and they are in
 *   a different part of the archive, so nothing else would ever bring them
 *   together.
 * - **Paragraphs are kept apart.** A bulleted list is separate `<a:p>` elements
 *   with no whitespace between them, so concatenating runs turns two real lines
 *   into one nonsense token.
 */
export const pptxHandler: FormatHandler = {
  mediaType: MediaType.Pptx,
  extensions: ['pptx'],
  shape: ByteShape.Zip,
  tabular: false,
  // One slide, one chunk, always — and never merged with the slide beside it,
  // whatever the budget says. Nothing to overlap either: a slide does not
  // continue into the next one.
  chunking: { boundary: Boundary.Page, overlap: false, carryHeadings: true },

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const parts = readParts(
      input.content,
      (name) => SLIDE.test(name) || NOTES.test(name) || RELS.test(name) || name === CORE,
    );

    // Numerically, never lexically. A real deck came back `slide1, slide10,
    // slide11, …, slide2`, and a lexical sort would have numbered thirteen
    // slides in an order nobody's deck is in — invisibly, since every chunk
    // would still look perfectly well-formed. `ordinal` is what neighbour
    // expansion joins on, so it has to mean what the deck means.
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
      // The deck's own title if it recorded one, else the first slide's. Never
      // invented: a model may write a real one later, and that is a rung above.
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
    // The notes are marked rather than run together with the body. A chunk that
    // quietly mixes what is on the slide with what the presenter meant to say is
    // one nobody can quote from with confidence.
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
   * A slide's speaker notes, found the way the format says to find them.
   *
   * **`notesSlide7.xml` is not the notes for `slide7.xml`**, and assuming it is
   * was a bug this very nearly shipped with. The parts are numbered in the order
   * they were *created*, so a deck where only slides 2, 5 and 9 have notes has
   * `notesSlide1`, `notesSlide2` and `notesSlide3` — and a positional guess
   * would have quietly stapled slide 9's notes onto slide 2. That text would
   * then be chunked, embedded and returned as though somebody had said it about
   * the wrong slide, with nothing anywhere reporting a problem.
   *
   * The mapping is in `ppt/slides/_rels/slideN.xml.rels`, which is the file
   * whose entire job is to say what this slide points at. Reading it costs one
   * more small part per slide and is the only correct answer.
   *
 * The positional guess survives as a fallback for a deck with no rels part at
 * all — some minimal generators omit them — where it is the only thing left to
 * try and is right whenever every slide has notes.
 */
function notesFor(parts: Map<string, string>, slide: string): string | undefined {
  const rels = parts.get(`${slide.replace('ppt/slides/', 'ppt/slides/_rels/')}.rels`);

  if (rels) {
    const found = NOTES_REL.exec(rels);
    const target = found?.[1] ?? found?.[2];
    // No relationship of that type is the ordinary case for a slide with no
    // notes, and it is an answer rather than a reason to go guessing.
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
 * Everything on the slide except the title, which is carried separately.
 *
 * Read shape by shape rather than over the whole slide at once, so that two text
 * boxes do not run into each other — and so the title can be left out without a
 * string replace, which would also have removed a body line that happened to
 * repeat it.
 */
function bodyOf(xml: string, title: string | null): string {
  const parts: string[] = [];

  for (const shape of xml.matchAll(SHAPE)) {
    const body = shape[1] ?? '';
    if (TITLE_ROLE.test(body)) continue;

    const text = textOf(body).trim();
    if (text.length > 0) parts.push(text);
  }

  // A slide whose text is all outside `<p:sp>` — inside a table or a graphic
  // frame — would otherwise come back empty. Falling back to the whole slide
  // costs a little ordering and saves the content.
  if (parts.length === 0) {
    const whole = textOf(xml).trim();
    return title ? whole.replace(title, '').trim() : whole;
  }
  return parts.join('\n\n');
}

/**
 * The deck's declared title. Often absent — a real deck had no `core.xml` at all
 * — so this is a bonus rather than something to rely on.
 */
function declaredTitle(parts: Map<string, string>): string | null {
  const core = parts.get(CORE);
  return core ? elementText(core, 'title') : null;
}

/**
 * A relationship target, resolved against `ppt/slides/` where they are written.
 *
 * Targets are relative — `../notesSlides/notesSlide1.xml` — so the `..` has to
 * be walked rather than pattern-matched. Segments that would climb above the
 * archive root are dropped rather than followed: these names are only ever used
 * as keys into a map read out of the same archive, so nothing here can reach a
 * filesystem, but a target that resolves to nothing is a better outcome than
 * one that resolves to something unexpected.
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
