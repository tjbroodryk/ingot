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
 * The registry, checked against itself: the mistakes the type system can't see
 * — an entry under the wrong key, two formats claiming one extension, and a
 * strategy that contradicts itself.
 */
describe('the format registry', () => {
  it('files every handler under its own media type', () => {
    for (const [key, handler] of Object.entries(FORMATS)) {
      expect({ key, mediaType: handler.mediaType }).toEqual({ key, mediaType: key as MediaType });
    }
  });

  it('gives every media type a handler', () => {
    // The compiler already enforces this; asserted to keep it visible.
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
    // Without one, `application/octet-stream` uploads could never reach the format.
    for (const handler of Object.values(FORMATS)) {
      expect(handler.extensions.length).toBeGreaterThan(0);
    }
  });

  /**
   * Overlap repeats the tail only when one group is cut: on for continuous prose,
   * off for discrete records where a repeated half carries nothing.
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
    // Budget formats have no headings; a PDF's are guessed from font runs, so a
    // wrong one embedded is worse than none.
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
    // `tabular` decides whether extraction costs a model call.
    const tabular = Object.values(FORMATS)
      .filter((handler) => handler.tabular)
      .map((handler) => handler.mediaType);

    expect(tabular).toEqual([MediaType.Csv]);
  });

  it('passes its own startup check', () => {
    expect(() => assertConsistent()).not.toThrow();
  });
});
