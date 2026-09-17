import { Body, Controller, Get, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AddResult, DeleteResult, PendingOperations } from '@ingot/shared/ingot-v1';
import { Wire } from '@ingot/versioning/nest';
import { Dispatcher } from '../../../shared/application/index.js';
import { WireShape } from '../../../versioning/shapes.js';
import type { Account } from '../../accounts/domain/index.js';
import { Account as AccountScope } from '../../accounts/interface/account.decorator.js';
import { CurrentAccount } from '../../accounts/interface/current-account.decorator.js';
import { AddRecords } from '../application/commands/add-records.command.js';
import { DeleteRecords } from '../application/commands/delete-records.command.js';
import { GetBaseFile } from '../application/queries/get-base-file.query.js';
import { GetPendingOperations } from '../application/queries/get-pending-operations.query.js';
import { AddDto } from './dto/add.dto.js';
import { DeleteDto } from './dto/delete.dto.js';
import { PendingDto } from './dto/pending.dto.js';

@Controller({ path: ':account/:ingot', version: '1' })
export class RecordsController {
  constructor(private readonly dispatcher: Dispatcher) {}

  /** Storing a tool result. Queryable the moment this returns. */
  @Post('add')
  @AccountScope()
  @Wire({ accepts: WireShape.AddBody, returns: WireShape.AddResult })
  add(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @Body() body: AddDto,
  ): Promise<AddResult> {
    return this.dispatcher.send(new AddRecords(ingot, account.id.value, body));
  }

  /**
   * Forgetting rows. A POST rather than a DELETE because it carries a
   * predicate, and a body on a DELETE is a thing intermediaries drop.
   */
  @Post('delete')
  @AccountScope()
  @Wire({ accepts: WireShape.DeleteBody, returns: WireShape.DeleteResult })
  forget(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @Body() body: DeleteDto,
  ): Promise<DeleteResult> {
    return this.dispatcher.send(new DeleteRecords(ingot, account.id.value, body));
  }

  /** What the next roll-up will fold in. Everything here is already queryable. */
  @Get('tables/:table/pending')
  @AccountScope()
  @Wire({ returns: WireShape.PendingOperations })
  pending(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @Param('table') table: string,
    @Query() page: PendingDto,
  ): Promise<PendingOperations> {
    return this.dispatcher.ask(new GetPendingOperations(ingot, account.id.value, table, page));
  }

  /**
   * The table's Parquet, streamed from the store.
   *
   * Unversioned: the file's schema is the table's, not this API's. What would
   * have gone in an envelope goes in headers instead.
   */
  @Get('tables/:table/parquet')
  @AccountScope()
  @Wire.Empty()
  async parquet(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @Param('table') table: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.dispatcher.ask(new GetBaseFile(ingot, account.id.value, table));

    response.setHeader('Ingot-Generation', String(file.generation));
    response.setHeader('Ingot-Tombstones', String(file.tombstones));
    return new StreamableFile(file.body, {
      type: 'application/vnd.apache.parquet',
      length: file.bytes,
      // Table names are SQL identifiers, so nothing here needs escaping.
      disposition: `attachment; filename="${file.table}-gen-${file.generation}.parquet"`,
    });
  }
}
