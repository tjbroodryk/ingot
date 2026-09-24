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

/** Account read, key minting and revocation. No route creates an account. */
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
