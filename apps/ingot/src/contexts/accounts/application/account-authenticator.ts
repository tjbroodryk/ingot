import { Inject, Injectable } from '@nestjs/common';
import { AuthenticationFailed, CLOCK, type Clock } from '../../../shared/domain/index.js';
import {
  ACCOUNT_REPOSITORY,
  type Account,
  ApiKey,
  type AccountRepository,
} from '../domain/index.js';
import type { AccountKeyId } from '../domain/index.js';

/** Who is calling, once a key has checked out. */
export interface AccountPrincipal {
  readonly account: Account;
  readonly keyId: AccountKeyId;
}

/**
 * Turns a presented key into a principal.
 *
 * Not a query, because it writes: every successful authentication stamps
 * `last_used_at`, which is the only way an operator can tell a live key from
 * one that was minted and forgotten. That write goes through
 * `AccountRepository.touch` rather than a save, so concurrent requests on one
 * key do not fight over the aggregate's version — see the note on that method.
 *
 * Failures are deliberately indistinguishable. A key that never existed, a key
 * that was revoked, and a key belonging to a deleted account all produce the
 * same error with the same message, because the difference between them is
 * information a caller holding an invalid key has not earned.
 */
@Injectable()
export class AccountAuthenticator {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async authenticate(presented: string): Promise<AccountPrincipal> {
    if (!ApiKey.looksLikeOurs(presented)) throw refused();

    const account = await this.accounts.findByKeyDigest(ApiKey.digestOf(presented));
    if (!account) throw refused();

    const key = account.authenticate(presented);
    if (!key) throw refused();

    const now = this.clock.now();
    account.markUsed(key.id, now);
    await this.accounts.touch(key.id, now);

    return { account, keyId: key.id };
  }
}

function refused(): AuthenticationFailed {
  return new AuthenticationFailed('That API key is not valid');
}
