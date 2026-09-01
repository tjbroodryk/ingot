import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { FtsStemmer, FtsStopwords } from '@ingot/shared/ingot-v1';

/**
 * The FTS half of a config patch, shape-checked only.
 *
 * `stemmer` and `stopwords` are strings here rather than `@IsEnum`, and that is
 * deliberate: `FtsSettings` parses them with `Guard.oneOf`, and it has to,
 * because the MCP surface builds this command without a pipe. A rule enforced
 * only by the DTO is a rule one of the two surfaces does not have.
 */
export class FtsConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(Object.values(FtsStemmer))
  stemmer?: FtsStemmer;

  /**
   * Checked here *and* in `FtsSettings`, unlike most of this file.
   *
   * DuckDB reads an unrecognised value as the name of a table to read
   * stopwords from, so this one is a boundary rather than a nicety — and the
   * MCP surface builds the command without passing through this pipe.
   */
  @IsOptional()
  @IsIn(Object.values(FtsStopwords))
  stopwords?: FtsStopwords;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  ignore?: string;

  @IsOptional()
  @IsBoolean()
  stripAccents?: boolean;

  @IsOptional()
  @IsBoolean()
  lowercase?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  columns?: string[];
}

export class ConfigureTableDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => FtsConfigDto)
  fts?: FtsConfigDto;
}
