import 'reflect-metadata';

export const WIRE_METADATA = 'versioning:wire';

/** One end of a route, named by the wire shape that crosses it. */
export interface ShapeRef {
  readonly shape: string;
  /** The payload is a list of them. */
  readonly array?: boolean;
  /** The payload is `{ items: [...] }` — a page of them. */
  readonly paged?: boolean;
}

export interface WireSpec {
  /** The shape of the request body, if the route takes one. */
  readonly accepts?: ShapeRef | string;
  /** The shape of the response body, if the route answers with one. */
  readonly returns?: ShapeRef | string;
}

/**
 * Declares which wire shapes cross a route, so a version's transforms know
 * what to apply.
 *
 * ```ts
 * @Wire({ accepts: 'AddBody', returns: 'AddResult' })
 * @Wire({ returns: { shape: 'IngotSummary', array: true } })
 * ```
 *
 * A route that declares nothing is served unversioned — its body passes
 * through untouched whatever version was asked for. That is correct for a
 * health check and wrong for everything else, which is why each service has a
 * test asserting every route declares one rather than leaving it to review.
 */
export function Wire(spec: WireSpec): MethodDecorator {
  return <T>(_target: object, _key: string | symbol, descriptor: TypedPropertyDescriptor<T>) => {
    if (descriptor.value) {
      Reflect.defineMetadata(WIRE_METADATA, spec, descriptor.value as object);
    }
  };
}

/**
 * This route carries no versioned body in either direction.
 *
 * A `204`, a health check, or a surface that is not this API's wire contract at
 * all — an MCP endpoint speaking JSON-RPC, say. Spelled as its own call rather
 * than `@Wire({})` so that "nothing crosses here" is a statement somebody made
 * on purpose, and so it is greppable when the reason stops being true.
 */
Wire.Empty = function Empty(): MethodDecorator {
  return Wire({});
};

export function readWire(handler: object): WireSpec | null {
  return (Reflect.getMetadata(WIRE_METADATA, handler) as WireSpec | undefined) ?? null;
}

/** Both spellings — `'AddBody'` and `{ shape: 'AddBody' }` — as one thing. */
export function asShapeRef(value: ShapeRef | string | undefined): ShapeRef | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? { shape: value } : value;
}
