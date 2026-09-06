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
 * The self-hosting mode, and the shape of it is the point: the root credential
 * is checked against a digest held in this process, not against a row. There
 * is nothing in the database that grants access, so there is nothing to
 * reconcile, nothing to leave behind on a rotation, and no stale row that is
 * quietly still a live credential. Rotation is a change to the secret and a
 * restart — the old key stops working as each pod comes up.
 *
 * Keys minted at runtime still authenticate, through the ordinary digest
 * lookup, and are still revocable. That is deliberate: one shared secret
 * across every agent means revoking one means rotating all of them, and the
 * root key exists so that doing so can never lock the account out. It is the
 * credential that cannot be revoked, not the only one that works.
 *
 * The two paths take measurably different time — the root key answers without
 * touching Postgres, a minted one does not. That distinguishes "this is not
 * the root key" from "this is not a key at all", which is a difference a
 * caller holding neither can already see in the 401 they get for both. It is
 * not the distinction `Account.authenticate` walks revoked keys to avoid; that
 * one would separate two kinds of failure for a caller who had held a valid
 * key, and this one does not.
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
   * The account exists, whichever replica gets here first.
   *
   * The chart defaults to two replicas and scales past that, so this runs
   * concurrently by design. It is safe because `account.slug` is unique: the
   * losers of the race get a `ConflictingState` out of the repository and take
   * the account the winner wrote.
   *
   * Nothing is written for the key. See the class note.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seed();
    } catch (error) {
      // The likeliest cause by a distance is an unmigrated database, and the
      // raw error for that is a relation-does-not-exist nobody reads as
      // "you skipped a step".
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
    // Not the root key, which is not the same as not a key. A key minted under
    // it is looked up, stamped and revocation-checked exactly as before.
    return this.keys.authenticate(presented);
  }

  private isRootKey(presented: string): boolean {
    // Shape first, so a request carrying something long and arbitrary is not
    // hashed before it is dismissed. `matches` is the constant-time half.
    return ApiKey.looksLikeOurs(presented) && ApiKey.matches(presented, this.settings.keyDigest);
  }

  private async account(): Promise<Account> {
    const account = await this.accounts.findBySlug(this.settings.slug);
    if (!account) {
      // Seeded at boot, so this is the row having been removed underneath a
      // running process rather than anything the caller did. Same answer as
      // any other failure regardless: they presented a key, and it does not
      // currently reach anything.
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
      // Another replica got there between the read above and this write.
      if (!(error instanceof ConflictingState)) throw error;
    }
  }
}
