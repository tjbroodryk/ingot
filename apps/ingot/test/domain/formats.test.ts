import { describe, expect, it } from 'bun:test';
import { Boundary, ByteShape } from '../../src/contexts/files/domain/format.js';
import {
  FORMATS,
  assertConsistent,
  handlerFor,
  knownExtensions,
  typeForExtension,
} from '../../src/contexts/files/domain/formats/index.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';

/**
 * The registry, checked against itself.
 *
 * Most of what used to need a test here is now a compile error instead —
 * `FORMATS` is a `Record<MediaType, FormatHandler>`, so a format that is named
 * without a handler, or a handler missing a field, does not build. What is left
 * is the small set of mistakes the type system cannot see: an entry filed under
 * the wrong key, two formats claiming one extension, and a strategy that
 * contradicts itself.
 *
 * Every one of those is silent in production. A handler under the wrong key
 * parses documents as something else; a shared extension resolves to whichever
 * entry was enumerated first. `assertConsistent` runs at boot for exactly that
 * reason, and this is what proves it would catch them.
 */
describe('the format registry', () => {
  it('files every handler under its own media type', () => {
    for (const [key, handler] of Object.entries(FORMATS)) {
      expect({ key, mediaType: handler.mediaType }).toEqual({ key, mediaType: key as MediaType });
    }
  });

  it('gives every media type a handler', () => {
    // The compiler already enforces this; asserting it keeps the guarantee
    // visible to somebody reading the tests rather than the type.
    for (const type of Object.values(MediaType)) {
      expect(handlerFor(type)).toBeDefined();
      expect(handlerFor(type).mediaType).toBe(type);
    }
  });

  it('lets no two formats claim the same extension', () => {
    const seen = new Set<string>();

    for (const handler of Object.values(FORMATS)) {
      for (const extension of handler.extensions) {
        expect(seen.has(extension)).toBe(false);
        seen.add(extension);
      }
    }
    expect(knownExtensions().length).toBe(seen.size);
  });

  it('resolves an extension back to the format that claims it', () => {
    for (const handler of Object.values(FORMATS)) {
      for (const extension of handler.extensions) {
        expect(typeForExtension(extension)).toBe(handler.mediaType);
      }
    }
    expect(typeForExtension('exe')).toBeNull();
  });

  it('gives every format at least one extension', () => {
    // Without one, a client sending `application/octet-stream` — which is most
    // of them — could never reach that format at all.
    for (const handler of Object.values(FORMATS)) {
      expect(handler.extensions.length).toBeGreaterThan(0);
    }
  });

  /**
   * Overlap is for prose that got cut, not for records that got listed.
   *
   * Writing this test is what showed the rule stated on `ChunkingStrategy` was
   * not the rule the code follows. The comment there claimed the flag stopped a
   * chunk bleeding across a boundary the document drew — but the chunker
   * overlaps only within the bodies one group produced, so it can never reach
   * across a group at all, whatever the flag says.
   *
   * What the flag actually decides is what happens when a *single* group is too
   * big and has to be cut: repeat the tail, or not. On where that cut goes
   * through continuous prose, because the sentence it severed is real. Off where
   * a group is discrete records — half a spreadsheet row repeated into the next
   * chunk carries nothing across and costs an embedding.
   */
  it('overlaps prose and does not overlap records', () => {
    for (const type of [MediaType.Pdf, MediaType.Text, MediaType.Markdown, MediaType.Html]) {
      expect({ type, overlap: FORMATS[type].chunking.overlap }).toEqual({ type, overlap: true });
    }

    for (const type of [MediaType.Csv, MediaType.Pptx]) {
      expect({ type, overlap: FORMATS[type].chunking.overlap }).toEqual({ type, overlap: false });
    }
  });

  it('gives the page boundary only to formats that really have pages', () => {
    const paged = Object.values(FORMATS)
      .filter((handler) => handler.chunking.boundary === Boundary.Page)
      .map((handler) => handler.mediaType);

    expect(new Set(paged)).toEqual(new Set([MediaType.Pdf, MediaType.Pptx]));
  });

  it('carries headings only where the format really has them', () => {
    // A budget-boundary format has no heading structure to carry, and a PDF's
    // headings are guessed from font runs — a wrong one embedded is worse than
    // none. Both would be silently poor retrieval rather than a failure.
    expect(FORMATS[MediaType.Pdf].chunking.carryHeadings).toBe(false);
    expect(FORMATS[MediaType.Text].chunking.carryHeadings).toBe(false);
    expect(FORMATS[MediaType.Csv].chunking.carryHeadings).toBe(false);
    expect(FORMATS[MediaType.Markdown].chunking.carryHeadings).toBe(true);
    expect(FORMATS[MediaType.Pptx].chunking.carryHeadings).toBe(true);
  });

  it('agrees with itself about what a format’s bytes look like', () => {
    expect(FORMATS[MediaType.Pdf].shape).toBe(ByteShape.Pdf);
    expect(FORMATS[MediaType.Pptx].shape).toBe(ByteShape.Zip);
    for (const type of [MediaType.Text, MediaType.Markdown, MediaType.Html, MediaType.Csv]) {
      expect(FORMATS[type].shape).toBe(ByteShape.Text);
    }
  });

  it('marks exactly the formats that already have rows of their own', () => {
    // `tabular` is what decides whether extraction costs a model call, so it is
    // worth stating rather than leaving to whoever adds the next handler.
    const tabular = Object.values(FORMATS)
      .filter((handler) => handler.tabular)
      .map((handler) => handler.mediaType);

    expect(tabular).toEqual([MediaType.Csv]);
  });

  it('passes its own startup check', () => {
    expect(() => assertConsistent()).not.toThrow();
  });
});
