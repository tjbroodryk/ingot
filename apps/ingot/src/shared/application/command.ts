import { Command as CqrsCommand } from '@nestjs/cqrs';
import type { CommandResult } from '@nestjs/cqrs';
import type { Isolation } from './ports/unit-of-work.port.js';

/**
 * An intent to change state, named as an imperative (`PostMessage`).
 *
 * The result type is carried in the class, so `dispatcher.send(new PostMessage(…))`
 * infers its return type with no cast at the call site. Commands return only
 * what the caller cannot derive — usually the identity of what was created.
 */
export abstract class Command<TResult = void> extends CqrsCommand<TResult> {
  readonly commandName: string;
  /**
   * The isolation of the transaction `Dispatcher` opens for this command.
   * Read committed unless a command has to read many tables as of one instant.
   */
  readonly isolation: Isolation = 'read committed';

  constructor() {
    super();
    this.commandName = new.target.name;
  }
}

/**
 * Implemented by exactly one handler per command. The `execute` return type is
 * pinned to the command's declared result, so a handler cannot drift from the
 * contract its callers were compiled against.
 */
export interface ICommandHandler<TCommand extends Command<unknown>> {
  execute(command: TCommand): Promise<CommandResult<TCommand>>;
}

export type { CommandResult };
