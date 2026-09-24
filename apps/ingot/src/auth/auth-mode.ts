/** How the service decides who is calling. */
export enum AuthMode {
  /** One account and one root key, both from configuration. See `SealedAuthenticator`. */
  Sealed = 'sealed',
}
