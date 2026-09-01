import { Metrics } from './metrics/catalogue.js';
import {
  NOTHING_RECORDED,
  instrumentMethod,
  operationRecorder,
  outcomeRecorder,
} from './observe.js';
import type { Detail } from './tracing/tracer.js';

/**
 * Any method the decorators below can wrap.
 *
 * `never[]` rather than `unknown[]` so that a method with real parameter types
 * still satisfies it — parameters are contravariant, and `never` is assignable
 * to anything. The wrapper never looks at the arguments, it only passes them
 * through, so this is the honest signature for "whatever was there".
 */
type Method = (...args: never[]) => unknown;

export interface ObservedOptions {
  /**
   * The name in Jaeger and in the `op` label.
   *
   * Defaults to `Class.method`, which is a fine name and a poor one: it is
   * accurate, and it changes when somebody renames a class, taking a
   * dashboard panel and an alert rule with it. Name the operation explicitly
   * — `forge.list_repos` — anywhere the number is going to be looked at
   * twice.
   */
  op?: string;
  /** Detail every call of this method carries, put on the span. */
  detail?: Detail;
}

/**
 * Measures a method: one span, one duration sample, both under one name.
 *
 * ```ts
 * class DuckDbEngine {
 *   @Observed({ op: 'ingot.query' })
 *   async query(plan: QueryPlan): Promise<QueryResult> { … }
 * }
 * ```
 *
 * This is `observe()` in decorator form and it behaves identically — the same
 * histogram, the same `outcome` label, the same exemplar linking a sample to
 * the trace it came from. Which of the two to use is a question about where
 * the boundary is: a whole method is a decorator, a stretch inside one is a
 * block.
 *
 * It works on synchronous methods too. A returned promise defers the
 * measurement to its settlement; anything else is measured on return.
 *
 * What it cannot do is see a method called from inside its own class through
 * `this.method()`… it can, actually — the wrapper is on the prototype. What
 * it genuinely cannot see is a private function that is not a method at all,
 * which is what `observe()` is for.
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
 * Traces a method without giving it a time series.
 *
 * For the layers where a span is the useful signal and a metric would be
 * noise: a projector step, a mapper, anything called often enough and varied
 * enough that its aggregate duration would not mean much. The trace still
 * shows it, which is where you would be looking anyway.
 */
export function Traced(options: ObservedOptions = {}) {
  return <T extends Method>(
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const op = options.op ?? defaultName(target, propertyKey);
    instrumentMethod(descriptor, op, options.detail, NOTHING_RECORDED);
  };
}

/**
 * Marks a method as a call to somebody else's service.
 *
 * ```ts
 * class GithubForge {
 *   @Upstream({ host: 'github', operation: 'list_repos' })
 *   async listRepos(actor: Actor): Promise<Repo[]> { … }
 * }
 * ```
 *
 * The decorator form of `upstream()`, and the natural fit for a provider
 * adapter, where the whole class is calls to one host and every public method
 * is one endpoint. Records into `forge_upstream_request_duration_seconds`
 * with the wider bucket set that external latency needs.
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

/**
 * `Class.method`, read off the prototype the decorator was applied to.
 *
 * `target` is the prototype for an instance method and the constructor itself
 * for a static one, so the name is fetched from whichever of the two is
 * actually the class.
 */
function defaultName(target: object, propertyKey: string | symbol): string {
  const owner =
    typeof target === 'function'
      ? (target as { name?: string })
      : ((target.constructor ?? {}) as { name?: string });
  return `${owner.name ?? 'anonymous'}.${String(propertyKey)}`;
}
