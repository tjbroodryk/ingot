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

/** The FTS half of a config patch, shape-checked only; `FtsSettings` parses the values. */
export class FtsConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(Object.values(FtsStemmer))
  stemmer?: FtsStemmer;

  // Checked here too: DuckDB reads an unrecognised value as a table name to read.
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
