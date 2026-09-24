import { Inject, Injectable } from '@nestjs/common';
import { AuthenticationFailed, CLOCK, type Clock } from '../../../shared/domain/index.js';
import type { KeyPrincipal } from '../../../auth/authenticator.port.js';
import { ACCOUNT_REPOSITORY, ApiKey, type AccountRepository } from '../domain/index.js';

/**
 * Resolves a presented key to a principal by digest lookup, stamping
 * `last_used_at` on success via `AccountRepository.touch`. Unknown, revoked,
 * and deleted-account keys all fail with the same error.
 */
@Injectable()
export class AccountAuthenticator {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async authenticate(presented: string): Promise<KeyPrincipal> {
    if (!ApiKey.looksLikeOurs(presented)) throw refused();

    const account = await this.accounts.findByKeyDigest(ApiKey.digestOf(presented));
    if (!account) throw refused();

    const key = account.authenticate(presented);
    if (!key) throw refused();

    const now = this.clock.now();
    account.markUsed(key.id, now);
    await this.accounts.touch(key.id, now);

    return { via: 'key', account, keyId: key.id };
  }
}

function refused(): AuthenticationFailed {
  return new AuthenticationFailed('That API key is not valid');
}
