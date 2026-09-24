import type { Account } from './account.aggregate.js';
import type { AccountId, AccountKeyId } from './account-id.vo.js';

export interface AccountRepository {
  save(account: Account): Promise<void>;
  findById(id: AccountId): Promise<Account | null>;
  findBySlug(slug: string): Promise<Account | null>;

  /** The authentication lookup: digest to account in one indexed hit. */
  findByKeyDigest(digest: string): Promise<Account | null>;

  /** Stamps `last_used_at` with a bare UPDATE, outside the aggregate's version. */
  touch(keyId: AccountKeyId, at: Date): Promise<void>;
}

export const ACCOUNT_REPOSITORY = Symbol('AccountRepository');
