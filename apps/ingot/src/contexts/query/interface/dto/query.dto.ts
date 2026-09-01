import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class QueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  sql?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  table?: string;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  column?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  limit?: number;
}
