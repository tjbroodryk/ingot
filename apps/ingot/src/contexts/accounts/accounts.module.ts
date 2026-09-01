import { Module } from '@nestjs/common';
import { CreateAccountHandler } from './application/commands/create-account.command.js';
import { MintKeyHandler } from './application/commands/mint-key.command.js';
import { RevokeKeyHandler } from './application/commands/revoke-key.command.js';
import { AccountAuthenticator } from './application/account-authenticator.js';
import { ACCOUNT_REPOSITORY } from './domain/index.js';
import { PgAccountRepository } from './infrastructure/postgres/pg-account.repository.js';
import { AccountsController } from './interface/accounts.controller.js';

/**
 * Exports the authenticator and the repository because the guards are bound
 * globally in `AppModule` and resolve them from there — the guards live in
 * this context but are applied to every route in the service.
 */
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
