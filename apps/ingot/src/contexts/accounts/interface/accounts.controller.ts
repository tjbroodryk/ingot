import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type { AccountDetail, MintedKey } from '@ingot/shared/ingot-v1';
import { Wire } from '@ingot/versioning/nest';
import { Dispatcher } from '../../../shared/application/index.js';
import { WireShape } from '../../../versioning/shapes.js';
import { MintKey } from '../application/commands/mint-key.command.js';
import { RevokeKey } from '../application/commands/revoke-key.command.js';
import type { Account } from '../domain/index.js';
import { toAccountWire, toKeyWire } from '../infrastructure/account.mapper.js';
import { Account as AccountScope } from './account.decorator.js';
import { MintKeyDto } from './dto/mint-key.dto.js';
import { CurrentAccount } from './current-account.decorator.js';

/**
 * The account, and the keys that speak for it.
 *
 * There is deliberately no route that creates an account. Every mode in
 * `AuthMode` decides up front which accounts exist — sealed mode has exactly
 * the one in `INGOT_ACCOUNT` — and the route that used to do it was the only
 * unauthenticated write in the service, handing anybody a permanent credential
 * for a tenant with no owner and no recovery. `CreateAccount` survives as a
 * command because the sealed seed and the test suite both open accounts; what
 * is gone is the ability to do it over HTTP with no credential.
 *
 * Registered before `IngotController` in `AppModule`, and that order is load
 * bearing: `/:account/:ingot` would otherwise match `/accounts/acme/keys` and
 * route key management into the memory API. `AccountSlug` refuses to mint an
 * account named `accounts` as the second half of that defence, and
 * `route-accounts.test.ts` asserts both still hold.
 */
@Controller({ path: 'accounts', version: '1' })
export class AccountsController {
  constructor(private readonly dispatcher: Dispatcher) {}

  @Get(':account')
  @AccountScope()
  @Wire({ returns: WireShape.AccountDetail })
  show(@CurrentAccount() account: Account): AccountDetail {
    return { ...toAccountWire(account), keys: account.keys.map(toKeyWire) };
  }

  @Post(':account/keys')
  @AccountScope()
  @Wire({ accepts: WireShape.MintKeyBody, returns: WireShape.MintedKey })
  @HttpCode(HttpStatus.CREATED)
  mint(@CurrentAccount() account: Account, @Body() body: MintKeyDto): Promise<MintedKey> {
    return this.dispatcher.send(new MintKey(account.id.value, body.label));
  }

  @Delete(':account/keys/:keyId')
  @AccountScope()
  @Wire.Empty() // 204
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@CurrentAccount() account: Account, @Param('keyId') keyId: string): Promise<void> {
    return this.dispatcher.send(new RevokeKey(account.id.value, keyId));
  }
}
