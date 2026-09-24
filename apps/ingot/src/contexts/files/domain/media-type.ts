/**
 * What this service will accept bytes of.
 *
 * A closed set. Every member has a handler in `FORMATS` (a `Record` over this
 * enum, so a member without one does not compile); anything else is refused at
 * `/file`. Names only, no imports, so both the registry and `detect.ts` can
 * import it without a cycle.
 */
export enum MediaType {
  Text = 'text/plain',
  Markdown = 'text/markdown',
  Html = 'text/html',
  Csv = 'text/csv',
  Pdf = 'application/pdf',
  Pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/*
 * `.docx` and `.xlsx` are absent: a name here without a handler in `FORMATS`
 * does not compile. Adding either is one member and one file next to `pptx.ts`.
 */
