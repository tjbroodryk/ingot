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
 *
 * The split is the house one — the pipe rejects a body that is not the right
 * kind of thing, the domain rejects one that does not make sense — and it
 * matters more than usual here. class-validator can say `columns` is an
 * object; it cannot say that `$.files[*.` is not a path, that a column has
 * both `from` and `value`, or that `INTEGER` is wrong for the value that
 * arrived. Those produce better errors from the code that understands them.
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

  /**
   * Which columns identify a row. Whether they are real columns is checked by
   * the table, since it is the table the key belongs to.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  key?: string[];

  @IsOptional()
  @IsBoolean()
  raw?: boolean;

  /**
   * Opt-in, because a receipt costs a read the write itself does not need.
   * Checked again in `ReceiptBuilder.kindOf`, which is the path the MCP
   * surface takes — it builds the same command without passing through a pipe.
   */
  @IsOptional()
  @IsIn(Object.values(ReceiptKind))
  receipt?: ReceiptKind;

  /**
   * The caller's own handle for this result — a tool call id, a job id.
   *
   * Bounded again in the command, which is the path the MCP surface takes:
   * it builds the same command without passing through this pipe.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalId?: string;

  /**
   * `@IsDefined` rather than a type check: the whole point is that this is an
   * arbitrary tool result. `null` is a legitimate one; an absent key is a
   * caller who forgot the payload.
   */
  @IsDefined()
  result!: unknown;
}
