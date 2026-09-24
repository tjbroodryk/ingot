import type { ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { asShapeRef, readWire, type ShapeRef } from './wire.decorator.js';

/**
 * How a service says which wire shapes a route deals in. A port: `@ingot/server`
 * declares it with `@Wire`; a service that already annotates its routes another
 * way supplies a resolver that reads its existing `@Returns`/`@WireBody` metadata.
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
