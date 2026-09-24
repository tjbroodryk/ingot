import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { IngotConfig } from '@ingot/shared/ingot-v1';
import {
  DELIVERY_SETTINGS,
  type DeliverySettings,
  unavailable,
} from '../../../../delivery/delivery-settings.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { InvariantViolation } from '../../../../shared/domain/index.js';
import { Delivery, INGOT_REPOSITORY, type IngotRepository } from '../../domain/index.js';
import { IngotAccess } from '../ingot-access.js';

/** `POST /api/v1/:account/:ingot/config` */
export class ConfigureIngot extends Command<IngotConfig> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    /** A `ConfigureIngotBody` as received, unparsed; `Delivery` parses it. */
    readonly settings: { readonly delivery?: unknown },
  ) {
    super();
  }
}

/**
 * Sets a memory's delivery target and returns the full config (the body is a
 * patch). Refuses an unavailable transport before touching the aggregate.
 */
@CommandHandler(ConfigureIngot)
export class ConfigureIngotHandler implements ICommandHandler<ConfigureIngot> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(DELIVERY_SETTINGS) private readonly delivery: DeliverySettings,
  ) {}

  async execute(command: ConfigureIngot): Promise<IngotConfig> {
    const ingot = await this.access.ingot(command.ingotId, command.accountId);

    if (command.settings.delivery !== undefined) {
      // Parsed before the availability check, so a bad kind reads as "not a transport".
      const wanted = Delivery.of(command.settings.delivery);
      const why = unavailable(this.delivery, wanted.kind);
      if (why) throw new InvariantViolation(`delivery.t is "${wanted.kind}", but ${why}`);
    }

    // Skip the save on a no-op; it would bump the version for nothing.
    if (ingot.configure(command.settings)) {
      await this.ingots.save(ingot);
    }

    return ingot.config;
  }
}
