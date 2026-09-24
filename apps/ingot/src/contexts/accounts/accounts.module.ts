import { Module } from '@nestjs/common';
import { CreateAccountHandler } from './application/commands/create-account.command.js';
import { MintKeyHandler } from './application/commands/mint-key.command.js';
import { RevokeKeyHandler } from './application/commands/revoke-key.command.js';
import { AccountAuthenticator } from './application/account-authenticator.js';
import { ACCOUNT_REPOSITORY } from './domain/index.js';
import { PgAccountRepository } from './infrastructure/postgres/pg-account.repository.js';
import { AccountsController } from './interface/accounts.controller.js';

/** Exports the authenticator and repository used by the globally-bound guards. */
@Module({
  controllers: [AccountsController],
  providers: [
    CreateAccountHandler,
    MintKeyHandler,
    RevokeKeyHandler,
    AccountAuthenticator,
    PgAccountRepository,
    { provide: ACCOUNT_REPOSITORY, useExisting: PgAccountRepository },
  ],
  exports: [AccountAuthenticator, ACCOUNT_REPOSITORY],
})
export class AccountsModule {}
