/**
 * What this service will accept bytes of.
 *
 * A closed set rather than "whatever a decoder might manage", because `/file` is
 * the one endpoint that takes opaque bytes from anyone holding a key and hands
 * them to a decoder. Every member here has a handler in `FORMATS` — the registry
 * is a `Record` over this enum, so a member added without one **does not
 * compile** — and anything outside it is refused at the door, where the caller is
 * still holding the response and can be told which types exist.
 *
 * **This file holds nothing but the names, and imports nothing at all.** The
 * signature, the extensions, whether a format is tabular and how it is chunked
 * all live on its handler; deciding which type an upload *is* lives in
 * `formats/detect.ts`, beside the registry it reads. Keeping the enum a leaf is
 * what lets both of those import it without a cycle — and keeping the facts on
 * the handlers is what stops there being two tables of format knowledge to
 * disagree with each other.
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
 * `.docx` and `.xlsx` are deliberately absent, where they were once named here
 * with no parser behind them.
 *
 * That split made sense while a format's *name* and a format's *reader* were
 * different things — the wire contract could describe more than the build could
 * do. Now a format is its handler and `FORMATS` is a `Record` over this enum, so
 * a name with nothing behind it is not a smaller promise, it is an impossible
 * state, and the compiler is what says so.
 *
 * The practical difference is only the wording of a refusal. Adding either is
 * one member here and one file next to `pptx.ts`, using the same zip machinery.
 */
