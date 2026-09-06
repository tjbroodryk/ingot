/**
 * How a deployment decides who is calling.
 *
 * The same shape of selector as `INGOT_STORAGE` and `INGOT_EMBEDDER`, and for
 * the same reason: authentication is a deployment's decision, not this
 * service's, and the ways of making it differ enough that they are separate
 * adapters rather than flags on one.
 *
 * There is deliberately no `open` mode — no way to run this service with
 * `POST /accounts` reachable by anybody. That was the old behaviour and it is
 * the hole this enum exists to close: anonymous account creation handing back
 * a permanent credential, with no owner, no recovery and no record of who did
 * it. Every mode here is closed.
 *
 * `AUTHENTICATORS` in `auth.module.ts` is a `Record` over this enum, so a mode
 * added here without an adapter fails to compile rather than falling through
 * to a default at runtime.
 */
export enum AuthMode {
  /**
   * One account and one root key, both from configuration.
   *
   * The self-hosting answer, and the whole of it: nothing to sign up for,
   * nothing to sign into, and no third party in the authentication path.
   * Rotation is a change to the secret and a restart.
   *
   * Keys minted at runtime still work and are still revocable — the root key
   * is the credential that cannot be locked out, not the only one that exists.
   * See `SealedAuthenticator`.
   */
  Sealed = 'sealed',
}
