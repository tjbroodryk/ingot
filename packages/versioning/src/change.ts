/**
 * One wire shape, as it crosses the boundary.
 *
 * Every versioned shape is an object — a list of them is handled by the caller
 * mapping over its elements — so a transform takes one and returns one.
 */
export type Payload = Record<string, unknown>;

/**
 * What one release did to one shape.
 *
 * The two directions are not optional decoration: `forward` migrates a *request*
 * written against the older shape up to the current one, and `backward` renders
 * the current *response* back down. A release that renames a field on a shape
 * used in both directions needs both, and the pair should round-trip.
 *
 * Only ever write the current shape in the codebase. That is the whole point of
 * this arrangement: handlers, DTOs and the wire contract describe the newest
 * version and nothing else, and every older version is a stack of small
 * transformations over it. The alternative — a branch per version inside the
 * handler — is how an endpoint ends up with four behaviours and one test.
 *
 * **Transforms must not walk into caller-owned data.** Some shapes carry
 * arbitrary values the caller themselves stored — `QueryResult.rows` is the
 * example in Ingot — and rewriting those would corrupt somebody's data in the
 * name of a field rename. Change the envelope, never the payload.
 */
export interface ShapeChange {
  /** The wire shape this touches, e.g. `IngotInfo`. */
  readonly shape: string;
  /** Why, in a sentence. Read by whoever is deciding whether to upgrade. */
  readonly note: string;
  /** Older request → current. Omit when the shape is response-only. */
  readonly forward?: (value: Payload) => Payload;
  /** Current response → older. Omit when the shape is request-only. */
  readonly backward?: (value: Payload) => Payload;
}

/** Everything one published version changed, and when it shipped. */
export interface Release<V extends string = string> {
  readonly version: V;
  /** What this release is about, for the changelog and `GET /versions`. */
  readonly summary: string;
  readonly changes: readonly ShapeChange[];
}
