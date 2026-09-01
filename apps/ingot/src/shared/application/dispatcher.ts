import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Metrics } from '../../observability/metrics/catalogue.js';
import { instrumented, outcomeRecorder } from '../../observability/observe.js';
import type { Command } from './command.js';
import { UNIT_OF_WORK, type UnitOfWork } from './ports/unit-of-work.port.js';
import type { Query } from './query.js';

/**
 * The only entry point the interface layer needs. Controllers depend on this
 * rather than on `CommandBus`/`QueryBus` directly, which keeps the read/write
 * split visible at every call site: `send` changes something, `ask` does not.
 *
 * That split is also why the transaction lives here. A command is the unit of
 * change, so it is the right unit of atomicity — and putting the boundary in
 * the one place every command passes through means a handler cannot forget to
 * open one. Queries get no transaction because they change nothing.
 *
 * It is also why both delivery surfaces go through it. The HTTP controllers
 * and the MCP tools build the same commands and hand them here; neither is
 * allowed its own implementation, which is what stops the MCP surface drifting
 * into a second, subtly different API. `mcp-parity.test.ts` holds that up.
 *
 * The same argument makes this where telemetry goes. Every command and query
 * is measured and traced because it came through here, not because somebody
 * remembered to annotate a handler.
 */
@Injectable()
export class Dispatcher {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  send<TResult>(command: Command<TResult>): Promise<TResult> {
    const name = command.commandName;
    return instrumented(
      `command.${name}`,
      { 'cqrs.kind': 'command', 'cqrs.name': name },
      outcomeRecorder(Metrics.CommandDuration, { command: name }),
      () => this.uow.run(() => this.commandBus.execute(command)),
    );
  }

  ask<TResult>(query: Query<TResult>): Promise<TResult> {
    const name = query.queryName;
    return instrumented(
      `query.${name}`,
      { 'cqrs.kind': 'query', 'cqrs.name': name },
      outcomeRecorder(Metrics.QueryDuration, { query: name }),
      () => this.queryBus.execute(query),
    );
  }
}
