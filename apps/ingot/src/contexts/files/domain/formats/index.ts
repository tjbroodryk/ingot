import { InvariantViolation } from '../../../../shared/domain/index.js';
import type { FormatHandler } from '../format.js';
import { MediaType } from '../media-type.js';
import { csvHandler } from './csv.js';
import { htmlHandler } from './html.js';
import { markdownHandler } from './markdown.js';
import { pdfHandler } from './pdf.js';
import { pptxHandler } from './pptx.js';
import { textHandler } from './text.js';

/** Every format this service reads, keyed on the enum so a missing handler does not build. */
export const FORMATS: Record<MediaType, FormatHandler> = {
  [MediaType.Text]: textHandler,
  [MediaType.Markdown]: markdownHandler,
  [MediaType.Html]: htmlHandler,
  [MediaType.Csv]: csvHandler,
  [MediaType.Pdf]: pdfHandler,
  [MediaType.Pptx]: pptxHandler,
};

/** The handler for a media type. Total, because the registry is exhaustive. */
export function handlerFor(mediaType: MediaType): FormatHandler {
  return FORMATS[mediaType];
}

/** The format claiming an extension, or null. Walked, not a second table. */
export function typeForExtension(extension: string): MediaType | null {
  const wanted = extension.toLowerCase();

  for (const handler of Object.values(FORMATS)) {
    if (handler.extensions.includes(wanted)) return handler.mediaType;
  }
  return null;
}

/** Every extension any format claims, for the message when none matches. */
export function knownExtensions(): readonly string[] {
  return Object.values(FORMATS).flatMap((handler) => handler.extensions);
}

/**
 * Refuses to boot on the two mistakes the type system cannot see: a handler
 * filed under the wrong key, and two formats claiming one extension.
 */
export function assertConsistent(): void {
  const claimed = new Map<string, MediaType>();

  for (const [key, handler] of Object.entries(FORMATS)) {
    if (handler.mediaType !== key) {
      throw new InvariantViolation(
        `The format registry lists "${handler.mediaType}" under the key "${key}". A handler ` +
          'filed under the wrong media type parses documents as something else.',
      );
    }

    for (const extension of handler.extensions) {
      const owner = claimed.get(extension);
      if (owner) {
        throw new InvariantViolation(
          `Both ${owner} and ${handler.mediaType} claim the extension ".${extension}". One ` +
            'extension means one format, or which handler runs depends on enumeration order.',
        );
      }
      claimed.set(extension, handler.mediaType);
    }
  }
}

/** The supported formats as one line, for the boot log. */
export function describeFormats(): string {
  return Object.values(FORMATS)
    .map((handler) => `${handler.mediaType} (.${handler.extensions.join(', .')})`)
    .join(', ');
}
