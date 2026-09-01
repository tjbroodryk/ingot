import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateAccountDto {
  /**
   * Checked here and again in `AccountSlug`. The pipe rejects the shape so the
   * caller gets a field-level error; the value object rejects the meaning —
   * reserved words — because that is a rule about this service rather than
   * about the string.
   */
  @IsString()
  @MinLength(2)
  @MaxLength(48)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase letters, digits and single hyphens',
  })
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
