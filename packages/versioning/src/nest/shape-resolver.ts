import type { ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { asShapeRef, readWire, type ShapeRef } from './wire.decorator.js';

/**
 * How a service says which wire shapes a route deals in.
 *
 * A port because the two services already answer this question differently.
 * `@ingot/server` declares it with `@Wire`, the decorator below. `@forge/api`
 * has carried `@Returns(Wire.X)` on every route and `@WireBody(Wire.X)` on
 * every DTO since long before versioning existed, and asking it to repeat
 * itself on fifty routes would be a large, mechanical, error-prone edit in
 * service of nothing — so it supplies a resolver that reads what is already
 * there.
 */
export interface ShapeResolver {
  accepts(context: ExecutionContext): ShapeRef | null;
  returns(context: ExecutionContext): ShapeRef | null;
}

export const SHAPE_RESOLVER = Symbol('ShapeResolver');

/** Reads the `@Wire` decorator. The default, and what Ingot uses. */
@Injectable()
export class WireShapeResolver implements ShapeResolver {
  accepts(context: ExecutionContext): ShapeRef | null {
    return asShapeRef(readWire(context.getHandler())?.accepts);
  }

  returns(context: ExecutionContext): ShapeRef | null {
    return asShapeRef(readWire(context.getHandler())?.returns);
  }
}
