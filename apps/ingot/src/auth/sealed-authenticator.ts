import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  AuthenticationFailed,
  type Clock,
  ConflictingState,
} from '../shared/domain/index.js';
import type { AccountAuthenticator } from '../contexts/accounts/application/account-authenticator.js';
import { Account, ApiKey, type AccountRepository } from '../contexts/accounts/domain/index.js';
import type { Authenticator, Principal } from './authenticator.port.js';
import type { SealedAuth } from './auth-settings.js';

/**
 * One account and one root key, both from configuration.
 *
 * The root key is checked against an in-process digest, not a row. Keys minted
 * at runtime still authenticate through the ordinary digest lookup and remain
 * revocable.
 */
export class SealedAuthenticator implements Authenticator, OnApplicationBootstrap {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly settings: SealedAuth,
    private readonly accounts: AccountRepository,
    private readonly keys: AccountAuthenticator,
    private readonly clock: Clock,
  ) {}

  describe(): string {
    return (
      `Sealed: the account "${this.settings.slug}", and the root key ` +
      `${this.settings.keyPrefix}… from INGOT_API_KEY. There is no route that creates an ` +
      'account — this deployment has exactly the one above.'
    );
  }

  /**
   * Seeds the sealed account. Safe to race: `account.slug` is unique, so
   * losers take the account the winner wrote. Nothing is written for the key.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seed();
    } catch (error) {
      // Likeliest cause is an unmigrated database, whose raw error is opaque.
      throw new Error(
        `Could not open the account "${this.settings.slug}" this deployment is sealed to. ` +
          'If this is a fresh database, its schema is not applied yet — ' +
          `run \`bun run db:migrate\` (or the chart's migration Job). Cause: ${String(error)}`,
      );
    }
  }

  async authenticate(presented: string): Promise<Principal> {
    if (this.isRootKey(presented)) {
      return { via: 'root', account: await this.account() };
    }
    // Not the root key: a minted key is looked up, stamped and revocation-checked.
    return this.keys.authenticate(presented);
  }

  private isRootKey(presented: string): boolean {
    // Shape check first so arbitrary input isn't hashed; `matches` is constant-time.
    return ApiKey.looksLikeOurs(presented) && ApiKey.matches(presented, this.settings.keyDigest);
  }

  private async account(): Promise<Account> {
    const account = await this.accounts.findBySlug(this.settings.slug);
    if (!account) {
      // Seeded at boot, so a missing row means it was removed out from under the process.
      this.logger.error(
        `The sealed account "${this.settings.slug}" is not in the database. ` +
          'Every request will be refused until it is back.',
      );
      throw new AuthenticationFailed('That API key is not valid');
    }
    return account;
  }

  private async seed(): Promise<void> {
    if (await this.accounts.findBySlug(this.settings.slug)) return;

    const account = Account.open({
      slug: this.settings.slug,
      name: this.settings.name,
      now: this.clock.now(),
    });

    try {
      await this.accounts.save(account);
      this.logger.log(`Opened the account "${this.settings.slug}".`);
    } catch (error) {
      // Another writer got there between the read above and this write.
      if (!(error instanceof ConflictingState)) throw error;
    }
  }
}
