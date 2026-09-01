import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MintKeyDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}
