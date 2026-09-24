/**
 * A caller named a version this service has never published. Carries the
 * available list; the Nest layer turns it into a 400.
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

/** The changeset itself is wrong — thrown at construction. */
export class MalformedChangeset extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedChangeset';
  }
}
