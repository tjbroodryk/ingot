import type { ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { asShapeRef, readWire, type ShapeRef } from './wire.decorator.js';

/**
 * How a service says which wire shapes a route deals in.
 *
 * A port because different services answer this question differently.
 * `@ingot/server` declares it with `@Wire`, the decorator below. A service that
 * already carries its shapes another way — `@Returns(Wire.X)` on every route,
 * `@WireBody(Wire.X)` on every DTO — should not have to repeat itself on fifty
 * routes in service of nothing, so it supplies a resolver that reads what is
 * already there.
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
