/** One wire shape, as it crosses the boundary. Always an object; a transform takes one and returns one. */
export type Payload = Record<string, unknown>;

/**
 * What one release did to one shape. `forward` migrates an older request up to
 * the current shape; `backward` renders the current response back down; the two
 * should round-trip. Change the envelope, never caller-owned payload data such
 * as `QueryResult.rows`.
 */
export interface ShapeChange {
  /** The wire shape this touches, e.g. `IngotInfo`. */
  readonly shape: string;
  /** What moved, in a sentence. */
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
