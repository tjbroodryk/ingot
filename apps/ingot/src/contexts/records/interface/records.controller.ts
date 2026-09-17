import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
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
import { ParquetDto, PendingDto } from './dto/pending.dto.js';
import { byteRange } from './byte-range.js';

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
    @Query() at: ParquetDto,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    const file = await this.dispatcher.ask(new GetBaseFile(ingot, account.id.value, table, at));

    response.setHeader('Ingot-Generation', String(file.generation));
    response.setHeader('Ingot-Part', String(file.part));
    if (file.tombstones !== null) response.setHeader('Ingot-Tombstones', String(file.tombstones));
    // A generation's object is written once and never changed, so its identity
    // is its address — which is what lets a proxy cache ranges of it.
    response.setHeader('ETag', `"${file.table}.${file.generation}.${file.part}.${file.bytes}"`);
    response.setHeader('Accept-Ranges', 'bytes');

    const type = 'application/vnd.apache.parquet';
    const wanted = byteRange(range, file.bytes);

    if (wanted === 'unsatisfiable') {
      response.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
      response.setHeader('Content-Range', `bytes */${file.bytes}`);
      return undefined;
    }
    if (wanted) {
      response.status(HttpStatus.PARTIAL_CONTENT);
      response.setHeader('Content-Range', `bytes ${wanted.start}-${wanted.end}/${file.bytes}`);
      return new StreamableFile(await file.open(wanted), {
        type,
        length: wanted.end - wanted.start + 1,
      });
    }

    return new StreamableFile(await file.open(), {
      type,
      length: file.bytes,
      // Table names are SQL identifiers, so nothing here needs escaping.
      disposition: `attachment; filename="${file.table}-gen-${file.generation}.parquet"`,
    });
  }
}
