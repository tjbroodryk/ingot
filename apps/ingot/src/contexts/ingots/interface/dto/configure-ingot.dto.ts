import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { DeliveryKind } from '@ingot/shared/ingot-v1';

/** The delivery half of a config patch, shape-checked only; `Delivery` decides validity. */
export class DeliveryStrategyDto {
  @IsIn(Object.values(DeliveryKind))
  t!: DeliveryKind;

  /** Length only; scheme, credentials and address ranges are `Delivery`'s. */
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
