import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** `CastIngotDto` with every field optional. */
export class CloneIngotDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+[mhdw]$/i, {
    message: 'retainFor must be a whole number and a unit: 30m, 12h, 14d, 4w',
  })
  retainFor?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  externalId?: string;
}
