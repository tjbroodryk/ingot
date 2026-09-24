import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Metrics } from '../../observability/metrics/catalogue.js';
import { instrumented, outcomeRecorder } from '../../observability/observe.js';
import type { Command } from './command.js';
import { UNIT_OF_WORK, type UnitOfWork } from './ports/unit-of-work.port.js';
import type { Query } from './query.js';

/**
 * The entry point the interface layer uses instead of `CommandBus`/`QueryBus`:
 * `send` changes state, `ask` does not. Commands run in a transaction here, and
 * both are measured and traced here rather than per handler.
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
