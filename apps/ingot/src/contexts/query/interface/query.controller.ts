import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type { QueryResult } from '@ingot/shared/ingot-v1';
import { Wire } from '@ingot/versioning/nest';
import { Dispatcher } from '../../../shared/application/index.js';
import { WireShape } from '../../../versioning/shapes.js';
import type { Account } from '../../accounts/domain/index.js';
import { Account as AccountScope } from '../../accounts/interface/account.decorator.js';
import { CurrentAccount } from '../../accounts/interface/current-account.decorator.js';
import { QueryIngot } from '../application/queries/query-ingot.query.js';
import { QueryDto } from './dto/query.dto.js';

@Controller({ path: ':account/:ingot', version: '1' })
export class QueryController {
  constructor(private readonly dispatcher: Dispatcher) {}

  /** A query, not a command: no transaction. POST (with explicit 200) because SQL does not belong in a URL. */
  @Post('query')
  @AccountScope()
  @Wire({ accepts: WireShape.QueryBody, returns: WireShape.QueryResult })
  @HttpCode(HttpStatus.OK)
  run(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @Body() body: QueryDto,
  ): Promise<QueryResult> {
    return this.dispatcher.ask(new QueryIngot(ingot, account.id.value, body));
  }
}
