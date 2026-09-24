import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateIngotDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Shape only; `Retention` enforces the bounds and does the arithmetic. */
  @IsOptional()
  @IsString()
  @Matches(/^\d+[mhdw]$/i, {
    message: 'retainFor must be a whole number and a unit: 30m, 12h, 14d, 4w',
  })
  retainFor?: string;
}
