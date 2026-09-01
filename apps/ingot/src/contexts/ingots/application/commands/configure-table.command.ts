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

/**
 * Sets how a table is read, and returns everything it is now set to.
 *
 * Returns the whole config rather than an acknowledgement because the body is
 * a patch: a caller who sent `{ fts: { stopwords: "none" } }` has just changed
 * one field of seven and has no way to know what the other six are without
 * being told. `/info` reports the same thing for every table at once.
 *
 * Nothing here touches the data. Settings say how the rows already stored are
 * indexed and matched, so changing them rebuilds an index on the next query
 * and rewrites no Parquet — which is why this is not a schema change and does
 * not carry a schema change's refusals.
 */
@CommandHandler(ConfigureTable)
export class ConfigureTableHandler implements ICommandHandler<ConfigureTable> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
  ) {}

  async execute(command: ConfigureTable): Promise<TableConfig> {
    const table = await this.access.table(command.ingotId, command.accountId, command.table);

    // `configure` reports whether anything moved, and a no-op is not written:
    // saving would take the table's version for a patch that changed nothing,
    // making whatever is adding rows to it right now retry for no reason.
    if (table.configure(command.settings)) {
      await this.tables.save(table);
    }

    return table.config.toWire();
  }
}
