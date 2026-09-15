import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { MAX_PENDING_PAGE } from '../../application/queries/get-pending-operations.query.js';

/** Query-string parameters, so the number arrives as a string and needs `@Type`. */
export class PendingDto {
  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'after must be the "next" of a previous page' })
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PENDING_PAGE)
  limit?: number;
}
