import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The non-file half of a `/file` upload, as multipart delivers it.
 *
 * One JSON field, not a flat form, so there is one wire shape for `FileBody`.
 * Validated here only as a bounded string; `FileMapping` checks what it means.
 */
export class FileDto {
  /** A JSON `FileBody`. Optional: a bare upload parses, chunks and embeds. */
  @IsOptional()
  @IsString()
  @MaxLength(64_000)
  body?: string;
}
