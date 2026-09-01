import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { MintedKey } from '@ingot/shared/ingot-v1';
import { AggregateNotFound, CLOCK, type Clock } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { ACCOUNT_REPOSITORY, AccountId, type AccountRepository } from '../../domain/index.js';
import { toMintedKey } from '../../infrastructure/account.mapper.js';

/** `POST /api/v1/accounts/:account/keys` */
export class MintKey extends Command<MintedKey> {
  constructor(
    readonly accountId: string,
    readonly label?: string,
  ) {
    super();
  }
}

@CommandHandler(MintKey)
export class MintKeyHandler implements ICommandHandler<MintKey> {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: MintKey): Promise<MintedKey> {
    const account = await this.accounts.findById(AccountId.of(command.accountId));
    if (!account) throw new AggregateNotFound('Account', command.accountId);

    const key = account.mint({ label: command.label, now: this.clock.now() });
    await this.accounts.save(account);

    const record = account.keys.find((candidate) => candidate.digest === key.digest);
    if (!record) throw new Error('The key just minted is not on the account');
    return toMintedKey(record, key.secret);
  }
}
