import { Module } from '@nestjs/common';
import { ConfigureIngotHandler } from './application/commands/configure-ingot.command.js';
import { ConfigureTableHandler } from './application/commands/configure-table.command.js';
import { CreateIngotHandler } from './application/commands/create-ingot.command.js';
import { DeleteIngotHandler } from './application/commands/delete-ingot.command.js';
import { DropTableHandler } from './application/commands/drop-table.command.js';
import { GetIngotInfoHandler } from './application/queries/get-ingot-info.query.js';
import { ListIngotsHandler } from './application/queries/list-ingots.query.js';
import { IngotAccess } from './application/ingot-access.js';
import { TableRegistry } from './application/table-registry.js';
import { INGOT_REPOSITORY, INGOT_TABLE_REPOSITORY } from './domain/index.js';
import {
  PgIngotRepository,
  PgIngotTableRepository,
} from './infrastructure/postgres/pg-ingot.repository.js';
import { IngotsController } from './interface/ingots.controller.js';

@Module({
  controllers: [IngotsController],
  providers: [
    ConfigureIngotHandler,
    ConfigureTableHandler,
    CreateIngotHandler,
    DeleteIngotHandler,
    DropTableHandler,
    GetIngotInfoHandler,
    ListIngotsHandler,
    IngotAccess,
    TableRegistry,
    PgIngotRepository,
    PgIngotTableRepository,
    { provide: INGOT_REPOSITORY, useExisting: PgIngotRepository },
    { provide: INGOT_TABLE_REPOSITORY, useExisting: PgIngotTableRepository },
  ],
  // The access helper, the registry and both repositories are exported because
  // the write path, the read path, the roll-up and `/file` all need them, and
  // every one of those lives in another context.
  exports: [IngotAccess, TableRegistry, INGOT_REPOSITORY, INGOT_TABLE_REPOSITORY],
})
export class IngotsModule {}
