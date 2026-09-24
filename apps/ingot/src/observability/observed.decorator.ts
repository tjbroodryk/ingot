import { Metrics } from './metrics/catalogue.js';
import { instrumentMethod, operationRecorder, outcomeRecorder } from './observe.js';
import type { Detail } from './tracing/tracer.js';

/** Any method the decorators below can wrap. `never[]` so any parameter types satisfy it. */
type Method = (...args: never[]) => unknown;

export interface ObservedOptions {
  /**
   * The span name and `op` label. Defaults to `Class.method`, which changes if
   * the class is renamed; name it explicitly where the number will be watched.
   */
  op?: string;
  /** Detail every call of this method carries, put on the span. */
  detail?: Detail;
}

/**
 * Measures a method: one span, one duration sample, under one name. `observe()`
 * in decorator form. Works on sync and async methods. For a non-method function,
 * use `observe()`.
 *
 * ```ts
 * class DuckDbEngine {
 *   @Observed({ op: 'ingot.query' })
 *   async query(plan: QueryPlan): Promise<QueryResult> { … }
 * }
 * ```
 */
export function Observed(options: ObservedOptions = {}) {
  return <T extends Method>(
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const op = options.op ?? defaultName(target, propertyKey);
    instrumentMethod(descriptor, op, options.detail, operationRecorder(op));
  };
}

/**
 * Marks a method as a call to an external service; the decorator form of
 * `upstream()`. Records into `UpstreamDuration`.
 *
 * ```ts
 * class OpenAiEmbedder {
 *   @Upstream({ host: 'openai', operation: 'embeddings' })
 *   async embed(texts: string[]): Promise<number[][]> { … }
 * }
 * ```
 */
export function Upstream(options: { host: string; operation: string; detail?: Detail }) {
  return <T extends Method>(
    _target: object,
    _propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const { host, operation } = options;
    instrumentMethod(
      descriptor,
      `${host}.${operation}`,
      { host, operation, ...options.detail },
      outcomeRecorder(Metrics.UpstreamDuration, { host, operation }),
    );
  };
}

/** `Class.method`. `target` is the prototype for an instance method, the constructor for a static one. */
function defaultName(target: object, propertyKey: string | symbol): string {
  const owner =
    typeof target === 'function'
      ? (target as { name?: string })
      : ((target.constructor ?? {}) as { name?: string });
  return `${owner.name ?? 'anonymous'}.${String(propertyKey)}`;
}
