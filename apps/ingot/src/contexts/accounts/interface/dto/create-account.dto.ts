import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateAccountDto {
  // Shape checked here; `AccountSlug` also rejects reserved words.
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
