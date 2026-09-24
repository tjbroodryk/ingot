import { Command as CqrsCommand } from '@nestjs/cqrs';
import type { CommandResult } from '@nestjs/cqrs';

/**
 * An intent to change state, named as an imperative (`PostMessage`).
 * The result type is carried in the class, so `send` infers it with no cast.
 */
export abstract class Command<TResult = void> extends CqrsCommand<TResult> {
  readonly commandName: string;

  constructor() {
    super();
    this.commandName = new.target.name;
  }
}

/** Implemented by exactly one handler per command; `execute` returns the command's declared result. */
export interface ICommandHandler<TCommand extends Command<unknown>> {
  execute(command: TCommand): Promise<CommandResult<TCommand>>;
}

export type { CommandResult };
