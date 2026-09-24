import type { Account, AccountKeyId } from '../contexts/accounts/domain/index.js';

/** Who is calling, once a credential has checked out. */
export type Principal = RootPrincipal | KeyPrincipal;

/** The configured root credential, which has no row in `account_key`. */
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

/** Turns a presented credential into a `Principal`. */
export interface Authenticator {
  /** One line for the boot log, saying what this deployment will accept. */
  describe(): string;

  /** Throws `AuthenticationFailed` for anything that does not check out. */
  authenticate(presented: string): Promise<Principal>;
}

export const AUTHENTICATOR = Symbol('Authenticator');
