import type { Account, AccountKeyId } from '../contexts/accounts/domain/index.js';

/**
 * Who is calling, once a credential has checked out.
 *
 * A union rather than one shape, because the two ways of arriving here differ
 * in something a caller downstream may need to know: a minted key has a row in
 * `account_key` that can be revoked and stamped, and the configured root key
 * has neither. Nothing in the service reads `keyId` today — both guards and
 * every controller want `account` and nothing else — but collapsing the two
 * into one optional field would make "there is no key id" and "the key id was
 * not looked up" the same value, and they are not.
 */
export type Principal = RootPrincipal | KeyPrincipal;

/**
 * The configured root credential, which has no row in `account_key`.
 *
 * Deliberately not seeded into the table. A row would be a second place the
 * truth lives, needing reconciliation every boot against a value that can
 * change underneath it — and a stale one would be a live credential nobody
 * meant to leave behind. The configuration is the authority; there is nothing
 * to keep in step with it.
 */
export interface RootPrincipal {
  readonly via: 'root';
  readonly account: Account;
}

/** A key minted at runtime, held as a digest and revocable. */
export interface KeyPrincipal {
  readonly via: 'key';
  readonly account: Account;
  readonly keyId: AccountKeyId;
}

/**
 * Turns a presented credential into a principal, however this deployment is
 * configured to decide that.
 *
 * The one port `AuthenticationGuard` resolves. The guard does not know which
 * mode it got and must not: that is the whole point of the selector, and it is
 * what keeps "how do we authenticate" a deployment's decision rather than
 * something baked into every route.
 */
export interface Authenticator {
  /**
   * One line for the boot log, saying what this deployment will accept.
   *
   * Required rather than optional, for the reason `Embedder.model` is: which
   * credentials a running service honours should be readable off the first ten
   * lines of a pod log, not inferred from which environment variables somebody
   * remembers setting.
   */
  describe(): string;

  /** Throws `AuthenticationFailed` for anything that does not check out. */
  authenticate(presented: string): Promise<Principal>;
}

export const AUTHENTICATOR = Symbol('Authenticator');
