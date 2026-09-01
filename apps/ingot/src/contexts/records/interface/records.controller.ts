import { Body, Controller, Param, Post } from '@nestjs/common';
import type { AddResult, DeleteResult } from '@ingot/shared/ingot-v1';
import { Wire } from '@ingot/versioning/nest';
import { Dispatcher } from '../../../shared/application/index.js';
import { WireShape } from '../../../versioning/shapes.js';
import type { Account } from '../../accounts/domain/index.js';
import { Account as AccountScope } from '../../accounts/interface/account.decorator.js';
import { CurrentAccount } from '../../accounts/interface/current-account.decorator.js';
import { AddRecords } from '../application/commands/add-records.command.js';
import { DeleteRecords } from '../application/commands/delete-records.command.js';
import { AddDto } from './dto/add.dto.js';
import { DeleteDto } from './dto/delete.dto.js';

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
}
