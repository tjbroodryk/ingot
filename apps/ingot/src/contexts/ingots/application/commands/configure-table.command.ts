import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { ConfigureTableBody, TableConfig } from '@ingot/shared/ingot-v1';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { INGOT_TABLE_REPOSITORY, type IngotTableRepository } from '../../domain/index.js';
import { IngotAccess } from '../ingot-access.js';

/** `POST /api/v1/:account/:ingot/config/:table` */
export class ConfigureTable extends Command<TableConfig> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly table: string,
    readonly settings: ConfigureTableBody,
  ) {
    super();
  }
}

/** Sets how a table is read and returns the full config (the body is a patch). Touches no data. */
@CommandHandler(ConfigureTable)
export class ConfigureTableHandler implements ICommandHandler<ConfigureTable> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
  ) {}

  async execute(command: ConfigureTable): Promise<TableConfig> {
    const table = await this.access.table(command.ingotId, command.accountId, command.table);

    // Skip the save on a no-op; it would bump the version for nothing.
    if (table.configure(command.settings)) {
      await this.tables.save(table);
    }

    return table.config.toWire();
  }
}
