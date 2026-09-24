import { IsString, MaxLength, MinLength } from 'class-validator';

export class DeleteDto {
  @IsString()
  @MaxLength(63)
  table!: string;

  /**
   * A predicate, not a statement. Wrapped in `SELECT _row_id FROM … WHERE (…)`
   * and put through the same single-SELECT check a query gets, since `1=1) --`
   * is a predicate too.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  where!: string;
}
