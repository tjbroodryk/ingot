import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { DeliveryKind } from '@ingot/shared/ingot-v1';

/**
 * The delivery half of a config patch, shape-checked only.
 *
 * `endpoint` and `queue` are plain optional strings here rather than fields
 * conditional on `t`, and that is deliberate: `Delivery` is what decides which
 * one a strategy needs and what a valid one looks like, and it has to, because
 * the MCP surface builds this command without passing through a pipe. A rule
 * enforced only by the DTO is a rule one of the two surfaces does not have.
 *
 * `t` is checked in both places for the same reason `stopwords` is on the table
 * DTO: it selects the branch, so a bad one should be refused as early as it can
 * be seen, with the list of what is allowed in the message.
 */
export class DeliveryStrategyDto {
  @IsIn(Object.values(DeliveryKind))
  t!: DeliveryKind;

  /**
   * Length only. The scheme, the credentials and the address ranges this
   * service refuses to connect to are `Delivery`'s, because they are the same
   * boundary whichever surface the call arrived on.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  endpoint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  queue?: string;
}

export class ConfigureIngotDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryStrategyDto)
  delivery?: DeliveryStrategyDto;
}
