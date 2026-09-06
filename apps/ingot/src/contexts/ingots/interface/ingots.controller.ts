import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type { IngotConfig, IngotInfo, IngotSummary, TableConfig } from '@ingot/shared/ingot-v1';
import { Wire } from '@ingot/versioning/nest';
import { Dispatcher } from '../../../shared/application/index.js';
import { WireShape } from '../../../versioning/shapes.js';
import { Account as AccountScope } from '../../accounts/interface/account.decorator.js';
import { CurrentAccount } from '../../accounts/interface/current-account.decorator.js';
import type { Account } from '../../accounts/domain/index.js';
import { ConfigureIngot } from '../application/commands/configure-ingot.command.js';
import { ConfigureTable } from '../application/commands/configure-table.command.js';
import { CreateIngot } from '../application/commands/create-ingot.command.js';
import { DeleteIngot } from '../application/commands/delete-ingot.command.js';
import { DropTable } from '../application/commands/drop-table.command.js';
import { GetIngotInfo } from '../application/queries/get-ingot-info.query.js';
import { ListIngots } from '../application/queries/list-ingots.query.js';
import { ConfigureIngotDto } from './dto/configure-ingot.dto.js';
import { ConfigureTableDto } from './dto/configure-table.dto.js';
import { CreateIngotDto } from './dto/create-ingot.dto.js';

/**
 * The memory itself: casting one, describing it, destroying it.
 *
 * Literal segments are declared before the parameterised ones. Express matches
 * in registration order, so `@Get('ingots')` after `@Get(':ingot/info')` would
 * be unreachable — a listing request would be read as a request for an ingot
 * called "ingots".
 */
@Controller({ path: ':account', version: '1' })
export class IngotsController {
  constructor(private readonly dispatcher: Dispatcher) {}

  @Post('create')
  @AccountScope()
  @Wire({ accepts: WireShape.CreateIngotBody, returns: WireShape.IngotSummary })
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentAccount() account: Account, @Body() body: CreateIngotDto): Promise<IngotSummary> {
    return this.dispatcher.send(new CreateIngot(account.id.value, body.name, body.retainFor));
  }

  @Get('ingots')
  @AccountScope()
  @Wire({ returns: { shape: WireShape.IngotSummary, array: true } })
  list(@CurrentAccount() account: Account): Promise<readonly IngotSummary[]> {
    return this.dispatcher.ask(new ListIngots(account.id.value));
  }

  /**
   * What a model reads before it writes SQL.
   *
   * Answered entirely from Postgres — no bucket read, no DuckDB session — so
   * asking what the columns are costs one indexed query rather than a round
   * trip to object storage.
   */
  @Get(':ingot/info')
  @AccountScope()
  @Wire({ returns: WireShape.IngotInfo })
  info(@CurrentAccount() account: Account, @Param('ingot') ingot: string): Promise<IngotInfo> {
    return this.dispatcher.ask(new GetIngotInfo(ingot, account.id.value, account.slug.value));
  }

  /**
   * Where this memory's receipts are delivered.
   *
   * Declared before `:ingot/config/:table`, because Express matches in
   * registration order and the two differ only by a trailing segment — the
   * more specific one is unreachable if the shorter pattern could also match.
   * It cannot here (one segment against two), but the ordering is the habit
   * that keeps it true when somebody adds `:ingot/config/:table/:column`.
   *
   * A patch, like the table config beside it: sending one setting leaves the
   * rest alone, and the whole config comes back. Turning delivery off is
   * `{ "delivery": { "t": "none" } }` and not an omission.
   */
  @Post(':ingot/config')
  @AccountScope()
  @Wire({ accepts: WireShape.ConfigureIngotBody, returns: WireShape.IngotConfig })
  @HttpCode(HttpStatus.OK)
  configureIngot(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @Body() body: ConfigureIngotDto,
  ): Promise<IngotConfig> {
    return this.dispatcher.send(new ConfigureIngot(ingot, account.id.value, body));
  }

  /**
   * How a table is read, not what is in it.
   *
   * A patch, so sending one setting leaves the rest alone, and the whole
   * config comes back — a caller who changed one field of seven otherwise has
   * no way to see the other six. `/info` reports the same for every table.
   */
  @Post(':ingot/config/:table')
  @AccountScope()
  @Wire({ accepts: WireShape.ConfigureTableBody, returns: WireShape.TableConfig })
  @HttpCode(HttpStatus.OK)
  configure(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @Param('table') table: string,
    @Body() body: ConfigureTableDto,
  ): Promise<TableConfig> {
    return this.dispatcher.send(new ConfigureTable(ingot, account.id.value, table, body));
  }

  @Delete(':ingot/tables/:table')
  @AccountScope()
  @Wire.Empty() // 204
  @HttpCode(HttpStatus.NO_CONTENT)
  dropTable(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @Param('table') table: string,
  ): Promise<void> {
    return this.dispatcher.send(new DropTable(ingot, account.id.value, table));
  }

  @Delete(':ingot')
  @AccountScope()
  @Wire.Empty() // 204
  @HttpCode(HttpStatus.NO_CONTENT)
  destroy(@CurrentAccount() account: Account, @Param('ingot') ingot: string): Promise<void> {
    return this.dispatcher.send(new DeleteIngot(ingot, account.id.value));
  }
}
