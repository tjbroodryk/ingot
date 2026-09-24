import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { type ColumnMapping, ReceiptKind } from '@ingot/shared/ingot-v1';

/**
 * The shape of an `/add`, checked here; the meaning is checked by `RowMapping`.
 * The pipe rejects a body of the wrong kind; the domain rejects a bad path, a
 * column with both `from` and `value`, or a type wrong for the value.
 */
export class AddDto {
  @IsString()
  @MaxLength(63)
  table!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  rows?: string;

  @IsObject()
  columns!: Record<string, ColumnMapping>;

  /** Which columns identify a row. Whether they are real columns is checked by the table. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  key?: string[];

  @IsOptional()
  @IsBoolean()
  raw?: boolean;

  /**
   * Opt-in, since a receipt costs an extra read. Checked again in
   * `ReceiptBuilder.kindOf`, the path the MCP surface takes without a pipe.
   */
  @IsOptional()
  @IsIn(Object.values(ReceiptKind))
  receipt?: ReceiptKind;

  /**
   * The caller's own handle for this result (a tool call id, a job id). Bounded
   * again in the command, the path the MCP surface takes without a pipe.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalId?: string;

  /**
   * `@IsDefined` rather than a type check: this is an arbitrary tool result.
   * `null` is legitimate; an absent key is a caller who forgot the payload.
   */
  @IsDefined()
  result!: unknown;
}
