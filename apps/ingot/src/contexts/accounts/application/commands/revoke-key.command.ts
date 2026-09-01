import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { AggregateNotFound, CLOCK, type Clock } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import {
  ACCOUNT_REPOSITORY,
  AccountId,
  AccountKeyId,
  type AccountRepository,
} from '../../domain/index.js';

/** `DELETE /api/v1/accounts/:account/keys/:keyId` */
export class RevokeKey extends Command {
  constructor(
    readonly accountId: string,
    readonly keyId: string,
  ) {
    super();
  }
}

@CommandHandler(RevokeKey)
export class RevokeKeyHandler implements ICommandHandler<RevokeKey> {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: RevokeKey): Promise<void> {
    const account = await this.accounts.findById(AccountId.of(command.accountId));
    if (!account) throw new AggregateNotFound('Account', command.accountId);

    account.revoke(AccountKeyId.of(command.keyId), this.clock.now());
    await this.accounts.save(account);
  }
}
