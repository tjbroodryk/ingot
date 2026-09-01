/**
 * A caller named a version this service has never published.
 *
 * Carries the list, because the useful answer to "2026-01-01 is not a version"
 * is "these are". The Nest layer turns it into a 400; the engine itself has no
 * opinion about HTTP.
 */
export class UnknownVersion extends Error {
  constructor(
    readonly requested: string,
    readonly available: readonly string[],
  ) {
    super(
      `"${requested}" is not a version of this API. Available: ${available.join(', ')}. ` +
        'Omit the header to use the newest.',
    );
    this.name = 'UnknownVersion';
  }
}

/** The changeset itself is wrong — thrown at construction, so at boot. */
export class MalformedChangeset extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedChangeset';
  }
}
