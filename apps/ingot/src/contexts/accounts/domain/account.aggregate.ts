import {
  ActionNotPermitted,
  AggregateRoot,
  Guard,
  InvariantViolation,
} from '../../../shared/domain/index.js';
import { AccountId, AccountKeyId } from './account-id.vo.js';
import { AccountSlug } from './account-slug.vo.js';
import { ApiKey } from './api-key.vo.js';

/** A key as the account holds it: a digest and the metadata around it. */
export interface AccountKeyRecord {
  readonly id: AccountKeyId;
  readonly digest: string;
  readonly prefix: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

interface AccountProps {
  slug: AccountSlug;
  name: string;
  createdAt: Date;
  keys: AccountKeyRecord[];
}

/**
 * A tenant, and the keys that speak for it.
 *
 * Keys live inside the account rather than as their own aggregate because the
 * invariant worth protecting is "this key belongs to exactly one account, and
 * revoking it is atomic with the account it belongs to". An account holds a
 * handful of keys, not thousands, so loading them together costs nothing — and
 * the authentication path needs both anyway.
 */
export class Account extends AggregateRoot<AccountId> {
  private props: AccountProps;

  private constructor(id: AccountId, props: AccountProps, version = 0) {
    super(id, version);
    this.props = props;
  }

  static open(input: { slug: string; name?: string; now: Date }): Account {
    const slug = AccountSlug.of(input.slug);
    const name = Guard.maxLength(
      Guard.notBlank(input.name?.trim() || slug.value, 'account.name'),
      120,
      'account.name',
    );
    return new Account(AccountId.generate(), {
      slug,
      name,
      createdAt: input.now,
      keys: [],
    });
  }

  static rehydrate(id: AccountId, props: AccountProps, version: number): Account {
    return new Account(id, props, version);
  }

  get slug(): AccountSlug {
    return this.props.slug;
  }
  get name(): string {
    return this.props.name;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get keys(): readonly AccountKeyRecord[] {
    return this.props.keys;
  }

  /**
   * Mints a key and returns the secret, which is the only time it exists.
   *
   * Capped, because an account with unbounded keys is an account whose
   * credentials cannot be audited — and because every authenticated request
   * walks this list.
   */
  mint(input: { label?: string; now: Date }): ApiKey {
    const live = this.props.keys.filter((key) => key.revokedAt === null);
    if (live.length >= 25) {
      throw new InvariantViolation(
        'This account already has 25 live keys — revoke one before minting another',
      );
    }

    const key = ApiKey.mint();
    const label = Guard.maxLength(input.label?.trim() || 'unnamed', 80, 'key.label');
    this.props.keys = [
      ...this.props.keys,
      {
        id: AccountKeyId.generate(),
        digest: key.digest,
        prefix: key.prefix,
        label,
        createdAt: input.now,
        lastUsedAt: null,
        revokedAt: null,
      },
    ];
    return key;
  }

  revoke(keyId: AccountKeyId, now: Date): void {
    const key = this.props.keys.find((candidate) => candidate.id.equals(keyId));
    if (!key) {
      throw new ActionNotPermitted(`Key "${keyId.value}" does not belong to this account`);
    }
    if (key.revokedAt !== null) return; // Already gone; saying so twice is not an error.

    // Revoking the last live key would lock the account out of its own data,
    // and there is no password reset on a machine-to-machine service.
    const live = this.props.keys.filter((candidate) => candidate.revokedAt === null);
    if (live.length === 1) {
      throw new InvariantViolation(
        'This is the account’s last live key — mint a replacement before revoking it',
      );
    }

    this.props.keys = this.props.keys.map((candidate) =>
      candidate.id.equals(keyId) ? { ...candidate, revokedAt: now } : candidate,
    );
  }

  /**
   * The key matching a presented secret, or null.
   *
   * Revoked keys are walked too, and rejected — skipping them early would make
   * "revoked" measurably faster to probe than "never existed".
   */
  authenticate(secret: string): AccountKeyRecord | null {
    for (const key of this.props.keys) {
      if (ApiKey.matches(secret, key.digest) && key.revokedAt === null) return key;
    }
    return null;
  }

  /** Records use without a version bump — see `AccountRepository.touch`. */
  markUsed(keyId: AccountKeyId, now: Date): void {
    this.props.keys = this.props.keys.map((candidate) =>
      candidate.id.equals(keyId) ? { ...candidate, lastUsedAt: now } : candidate,
    );
  }
}
