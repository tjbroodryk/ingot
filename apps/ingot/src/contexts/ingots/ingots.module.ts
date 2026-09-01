import { Module } from '@nestjs/common';
import { ConfigureTableHandler } from './application/commands/configure-table.command.js';
import { CreateIngotHandler } from './application/commands/create-ingot.command.js';
import { DeleteIngotHandler } from './application/commands/delete-ingot.command.js';
import { DropTableHandler } from './application/commands/drop-table.command.js';
import { GetIngotInfoHandler } from './application/queries/get-ingot-info.query.js';
import { ListIngotsHandler } from './application/queries/list-ingots.query.js';
import { IngotAccess } from './application/ingot-access.js';
import { INGOT_REPOSITORY, INGOT_TABLE_REPOSITORY } from './domain/index.js';
import {
  PgIngotRepository,
  PgIngotTableRepository,
} from './infrastructure/postgres/pg-ingot.repository.js';
import { IngotsController } from './interface/ingots.controller.js';

@Module({
  controllers: [IngotsController],
  providers: [
    ConfigureTableHandler,
    CreateIngotHandler,
    DeleteIngotHandler,
    DropTableHandler,
    GetIngotInfoHandler,
    ListIngotsHandler,
    IngotAccess,
    PgIngotRepository,
    PgIngotTableRepository,
    { provide: INGOT_REPOSITORY, useExisting: PgIngotRepository },
    { provide: INGOT_TABLE_REPOSITORY, useExisting: PgIngotTableRepository },
  ],
  // The access helper and both repositories are exported because the write
  // path, the read path and the roll-up all need them, and all three live in
  // other contexts.
  exports: [IngotAccess, INGOT_REPOSITORY, INGOT_TABLE_REPOSITORY],
})
export class IngotsModule {}
