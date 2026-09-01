import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateIngotDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /**
   * Shape checked here, meaning checked by `Retention` — which is also the path
   * the MCP surface takes, since it builds the command without a pipe. The
   * bounds and the arithmetic live there.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d+[mhdw]$/i, {
    message: 'retainFor must be a whole number and a unit: 30m, 12h, 14d, 4w',
  })
  retainFor?: string;
}
