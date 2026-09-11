import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The non-file half of a `/file` upload, as multipart delivers it.
 *
 * **One JSON field rather than a flat form**, and that is a deliberate choice
 * against the grain of multipart. A form with `extract.columns.total.type` in
 * the field names would be a second encoding of `FileExtraction` — one that
 * `@ingot/shared` does not describe, that no version transform could reach, and
 * that would drift from the JSON shape the moment either moved. Sending the
 * document's metadata as one JSON string keeps exactly one wire shape for it,
 * and the same one `AddBody` uses for its mapping.
 *
 * So the part is validated here only as *a bounded string*. What it means is
 * `FileBody`'s business and is checked by `FileMapping`, which is the house
 * split: the pipe rejects a body that is not the right kind of thing, and the
 * domain rejects one that does not make sense.
 */
export class FileDto {
  /**
   * A JSON `FileBody`. Optional, because the useful default is no body at all:
   * a bare upload parses, chunks and embeds, which is what almost everybody
   * wants. Everything in it is a rung above that.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64_000)
  body?: string;
}
