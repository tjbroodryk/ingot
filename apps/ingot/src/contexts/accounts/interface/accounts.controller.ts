import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type { AccountDetail, CreatedAccount, MintedKey } from '@ingot/shared/ingot-v1';
import { Wire } from '@ingot/versioning/nest';
import { Dispatcher } from '../../../shared/application/index.js';
import { WireShape } from '../../../versioning/shapes.js';
import { CreateAccount } from '../application/commands/create-account.command.js';
import { MintKey } from '../application/commands/mint-key.command.js';
import { RevokeKey } from '../application/commands/revoke-key.command.js';
import type { Account } from '../domain/index.js';
import { toAccountWire, toKeyWire } from '../infrastructure/account.mapper.js';
import { Account as AccountScope } from './account.decorator.js';
import { CreateAccountDto } from './dto/create-account.dto.js';
import { MintKeyDto } from './dto/mint-key.dto.js';
import { CurrentAccount } from './current-account.decorator.js';

/**
 * Sign-up and credentials.
 *
 * Registered before `IngotController` in `AppModule`, and that order is load
 * bearing: `/:account/:ingot` would otherwise match `/accounts/acme/keys` and
 * route key management into the memory API. `AccountSlug` refuses to mint an
 * account named `accounts` as the second half of that defence, and
 * `route-collision.test.ts` asserts both still hold.
 */
@Controller({ path: 'accounts', version: '1' })
export class AccountsController {
  constructor(private readonly dispatcher: Dispatcher) {}

  /**
   * The only route on the service that needs no key, because it is where keys
   * come from. The response carries a usable secret exactly once.
   */
  @Post()
  @AccountScope.Open()
  @Wire({ accepts: WireShape.CreateAccountBody, returns: WireShape.CreatedAccount })
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateAccountDto): Promise<CreatedAccount> {
    return this.dispatcher.send(new CreateAccount(body.slug, body.name));
  }

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
