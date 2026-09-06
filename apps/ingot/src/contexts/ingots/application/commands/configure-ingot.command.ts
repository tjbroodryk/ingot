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
    /**
     * A `ConfigureIngotBody` as it arrives: shape-checked by the DTO on the
     * HTTP path, not checked at all on the MCP one, and parsed by `Delivery`
     * on both. Typed as unparsed rather than as the union, because claiming
     * the union here would be a cast dressed as a signature.
     */
    readonly settings: { readonly delivery?: unknown },
  ) {
    super();
  }
}

/**
 * Sets where a memory's receipts are delivered, and returns everything it is
 * now set to.
 *
 * Returns the whole config rather than an acknowledgement, for the reason
 * `ConfigureTable` does: the body is a patch, so a caller who sent one field
 * has no way to see the others without being told.
 *
 * **A transport this deployment cannot honour is refused here**, on the call
 * that names it. The alternative is accepting the configuration and failing
 * every delivery afterwards — in a worker, hours later, into a log the person
 * who made the call cannot see. `unavailable` is the check, and it is asked
 * before the aggregate is touched so a refusal changes nothing.
 *
 * Nothing here touches the receipts already queued. A delivery records its
 * target when it is announced, so changing this points the *next* receipt
 * somewhere new and leaves the ones in flight going where they were promised.
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
      // Parsed before it is checked, so `{ "t": "rabbit" }` is "not a
      // transport" rather than "this deployment has no broker".
      const wanted = Delivery.of(command.settings.delivery);
      const why = unavailable(this.delivery, wanted.kind);
      if (why) throw new InvariantViolation(`delivery.t is "${wanted.kind}", but ${why}`);
    }

    // `configure` reports whether anything moved, and a no-op is not written:
    // saving would take the memory's version for a patch that changed nothing,
    // making whatever is writing to it right now retry for no reason.
    if (ingot.configure(command.settings)) {
      await this.ingots.save(ingot);
    }

    return ingot.config;
  }
}
