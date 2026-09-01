import type { Account } from './account.aggregate.js';
import type { AccountId, AccountKeyId } from './account-id.vo.js';

export interface AccountRepository {
  save(account: Account): Promise<void>;
  findById(id: AccountId): Promise<Account | null>;
  findBySlug(slug: string): Promise<Account | null>;

  /**
   * The authentication lookup: digest to account, in one indexed hit.
   *
   * By digest rather than by scanning every account's keys, because this runs
   * on every request. The digest column is unique, so a match identifies both
   * the account and the key.
   */
  findByKeyDigest(digest: string): Promise<Account | null>;

  /**
   * Stamps `last_used_at` outside the aggregate's version.
   *
   * Deliberately not a `save`. Every authenticated request touches a key, and
   * routing that through the optimistic-concurrency check would make two
   * concurrent requests on one key a 409 — the account would be unusable in
   * exact proportion to how much it was used. This is a bare `UPDATE` of a
   * field nothing decides anything on.
   */
  touch(keyId: AccountKeyId, at: Date): Promise<void>;
}

export const ACCOUNT_REPOSITORY = Symbol('AccountRepository');
