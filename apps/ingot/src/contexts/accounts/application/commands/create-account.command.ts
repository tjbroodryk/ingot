import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { CreatedAccount } from '@ingot/shared/ingot-v1';
import { CLOCK, type Clock, ConflictingState } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { ACCOUNT_REPOSITORY, Account, type AccountRepository } from '../../domain/index.js';
import { toCreatedAccount } from '../../infrastructure/account.mapper.js';

/** `POST /api/v1/accounts` */
export class CreateAccount extends Command<CreatedAccount> {
  constructor(
    readonly slug: string,
    readonly name?: string,
  ) {
    super();
  }
}

/**
 * The one unauthenticated write in the service.
 *
 * It hands back a key, which is the only moment that key exists in a readable
 * form — everything after this point is digests. So the response is the
 * product: a caller who loses it has to mint another, and cannot recover this
 * one.
 */
@CommandHandler(CreateAccount)
export class CreateAccountHandler implements ICommandHandler<CreateAccount> {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: CreateAccount): Promise<CreatedAccount> {
    const now = this.clock.now();
    const account = Account.open({ slug: command.slug, name: command.name, now });

    // Checked here for the message, enforced by a unique index for the race.
    // Two requests for the same slug in the same instant both pass this and
    // one of them hits the constraint; the repository turns that into the
    // same ConflictingState, so the caller sees one answer either way.
    if (await this.accounts.findBySlug(account.slug.value)) {
      throw new ConflictingState(`The account slug "${account.slug.value}" is taken`);
    }

    const key = account.mint({ label: 'initial', now });
    await this.accounts.save(account);
    return toCreatedAccount(account, key);
  }
}
