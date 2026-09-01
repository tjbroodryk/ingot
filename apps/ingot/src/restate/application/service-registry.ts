import { Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import {
  createObjectHandler,
  createObjectSharedHandler,
  createServiceHandler,
  createWorkflowHandler,
  createWorkflowSharedHandler,
  object,
  service,
  workflow,
  type Context,
  type ObjectContext,
  type ObjectSharedContext,
  type ServiceDefinition,
  type WorkflowContext,
  type WorkflowSharedContext,
  type VirtualObjectDefinition,
  type WorkflowDefinition,
} from '@restatedev/restate-sdk';
import { readCronSpec, type CronSpec } from '../cron.decorator.js';
import {
  RestateKind,
  readRestateBinding,
  readRestateHandler,
  type ErasedHandlerOptions,
  type RestateBinding,
  type RestateHandlerBinding,
} from '../restate.decorator.js';

/** Anything the endpoint can be handed to serve. */
export type RestateDefinition =
  | ServiceDefinition<string, unknown>
  | VirtualObjectDefinition<string, unknown>
  | WorkflowDefinition<string, unknown>;

/**
 * A handler, bound to the instance the container built.
 *
 * Every context the SDK passes — object, shared, workflow — extends `Context`,
 * so this one signature is assignable wherever a handler is expected and the
 * registry does not need one shape per kind.
 */
type BoundHandler = (ctx: Context, input: unknown) => Promise<unknown>;

/** One decorated provider, as Restate will come to know it. */
export interface DiscoveredService {
  readonly binding: RestateBinding;
  /** Handler names in declaration order — the second segment of each path. */
  readonly handlers: readonly string[];
  readonly definition: RestateDefinition;
  /**
   * The schedule, for a service that declared one with `@RestateCron`.
   *
   * Carried here rather than read from the class again elsewhere, because
   * "everything that should be ticking" is a question with one honest answer
   * — what the container actually built — and this is where that is already
   * known. `CronStarter` reads it to kick each chain on boot.
   */
  readonly cron?: CronSpec;
}

/**
 * The endpoint's contents, read off the running container.
 *
 * There is no list of Restate services anywhere in this codebase, and that is
 * the point. `DiscoveryModule` hands over the providers Nest actually built,
 * so what gets served is what got wired: a service dropped from its module
 * disappears from the endpoint on the same commit, and one added to a module
 * needs no second registration to be reachable.
 *
 * It is also what makes handlers ordinary application code. A definition
 * written at module scope — `restate.service({ handlers: { … } })` — closes
 * over whatever it can reach from a file, which in a container-shaped
 * application is nothing; this way a handler is a method on a provider, takes
 * its collaborators in its constructor, and is as testable as any other class.
 *
 * Everything below happens once, at endpoint start, and every failure it
 * detects is fatal there rather than discovered by an invocation months later
 * — a handler on an undecorated class, two services claiming one name, a
 * workflow with no `run`.
 */
@Injectable()
export class RestateServices {
  private cached: DiscoveredService[] | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  /** Every bound service, built once and kept. */
  discover(): DiscoveredService[] {
    if (!this.cached) this.cached = this.build();
    return this.cached;
  }

  private build(): DiscoveredService[] {
    const discovered: DiscoveredService[] = [];
    const claimed = new Map<string, string>();
    // A provider exported by one module and imported by three has a wrapper in
    // each, all pointing at one instance. Identity is what tells that apart
    // from the same class genuinely registered twice, which is a real
    // duplicate and is refused below.
    const seen = new Set<object>();

    for (const wrapper of this.discovery.getProviders()) {
      const target = wrapper.metatype;
      if (typeof target !== 'function' || !target.prototype) continue;

      const binding = readRestateBinding(target);
      const instance = wrapper.instance as object | undefined;

      // A handler is bound to an instance, once, at start. Anything Nest
      // builds per request — or that depends on something built per request —
      // has no instance to bind and no request to make one in, and would
      // otherwise be served with whatever placeholder the container is
      // holding. The failure that replaces is a handler whose collaborators
      // are all undefined, at the first invocation.
      if (binding && !wrapper.isDependencyTreeStatic()) {
        throw new Error(
          `${target.name} is bound as Restate service '${binding.name}' but is not a singleton — the endpoint is built once, at start, so a request-scoped provider cannot serve one.`,
        );
      }

      if (!instance || typeof instance !== 'object') continue;

      if (seen.has(instance)) continue;
      seen.add(instance);

      const handlers = this.handlersOf(instance);

      if (!binding) {
        // A handler on a class nobody bound is the mistake this catches: it
        // compiles, it is a perfectly good method, and it is unreachable.
        if (handlers.length > 0) {
          throw new Error(
            `${target.name} has @RestateHandler methods but no @RestateService, @RestateObject or @RestateWorkflow.`,
          );
        }
        continue;
      }

      if (handlers.length === 0) {
        throw new Error(
          `${target.name} is bound as Restate service '${binding.name}' but declares no @RestateHandler methods.`,
        );
      }

      const owner = claimed.get(binding.name);
      if (owner) {
        throw new Error(
          `Restate service name '${binding.name}' is claimed by both ${owner} and ${target.name}.`,
        );
      }
      claimed.set(binding.name, target.name);

      const cron = readCronSpec(target);

      discovered.push({
        binding,
        ...(cron ? { cron } : {}),
        handlers: handlers.map(([name]) => name),
        definition: define(binding, handlers, target.name),
      });
    }

    return discovered.sort((a, b) => a.binding.name.localeCompare(b.binding.name));
  }

  /**
   * The decorated methods of one instance, bound to it.
   *
   * Read off the prototype, where the decorator left its metadata, and bound
   * to the instance the container built — which is what carries the
   * constructor's dependencies into a function the SDK will call with no
   * receiver of its own.
   */
  private handlersOf(instance: object): Bound[] {
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
    const found: Bound[] = [];

    for (const property of this.scanner.getAllMethodNames(prototype)) {
      const method = prototype[property];
      if (typeof method !== 'function') continue;

      const handler = readRestateHandler(method);
      if (!handler) continue;

      found.push([handler.name, handler, (method as BoundHandler).bind(instance)]);
    }

    return found;
  }
}

/** One entry of a bound class: the name Restate uses, its options, its method. */
type Bound = readonly [name: string, handler: RestateHandlerBinding, fn: BoundHandler];

/**
 * Hands one binding's handlers to the SDK factory its kind calls for.
 *
 * Written out three times rather than abstracted, because the three factories
 * are genuinely different functions taking genuinely different contexts — a
 * virtual object's handler is handed the key and the state, a workflow's `run`
 * is handed a promise it can be signalled through — and the version of this
 * that unifies them replaces that distinction with a cast.
 */
function define(
  binding: RestateBinding,
  handlers: readonly Bound[],
  className: string,
): RestateDefinition {
  if (binding.kind === RestateKind.Service) return defineService(binding, handlers, className);
  if (binding.kind === RestateKind.VirtualObject) return defineObject(binding, handlers);
  return defineWorkflow(binding, handlers, className);
}

function defineService(
  binding: RestateBinding,
  handlers: readonly Bound[],
  className: string,
): ServiceDefinition<string, unknown> {
  const wrapped: Record<string, BoundHandler> = {};

  for (const [name, handler, fn] of handlers) {
    if (handler.shared) {
      throw new Error(
        `${className}.${name} is marked shared, but '${binding.name}' is a service: nothing is keyed, so every invocation is already concurrent. Use @RestateObject where invocations need serialising per key.`,
      );
    }
    wrapped[name] = createServiceHandler(sdkOptions(handler.options), fn);
  }

  return service({ ...named(binding), handlers: wrapped });
}

function defineObject(
  binding: RestateBinding,
  handlers: readonly Bound[],
): VirtualObjectDefinition<string, unknown> {
  const wrapped: Record<
    string,
    | ((ctx: ObjectContext, input: unknown) => Promise<unknown>)
    | ((ctx: ObjectSharedContext, input: unknown) => Promise<unknown>)
  > = {};

  for (const [name, handler, fn] of handlers) {
    wrapped[name] = handler.shared
      ? createObjectSharedHandler(sdkOptions(handler.options), fn)
      : createObjectHandler(sdkOptions(handler.options), fn);
  }

  return object({ ...named(binding), handlers: wrapped });
}

function defineWorkflow(
  binding: RestateBinding,
  handlers: readonly Bound[],
  className: string,
): WorkflowDefinition<string, unknown> {
  const shared: Record<string, (ctx: WorkflowSharedContext, input: unknown) => Promise<unknown>> =
    {};
  let run: ((ctx: WorkflowContext, input: unknown) => Promise<unknown>) | null = null;

  for (const [name, handler, fn] of handlers) {
    // Not a convention of ours: `run` is the workflow, and the SDK will not
    // accept a definition without one. Everything else is a way to watch or
    // signal a run already under way, which is what a shared handler is — so
    // they are marked so here rather than each of them having to remember.
    if (name === WORKFLOW_ENTRY) {
      if (handler.shared) {
        throw new Error(
          `${className}.run is marked shared, but a workflow's run is the workflow — it writes state and executes once per key.`,
        );
      }
      run = createWorkflowHandler(sdkOptions(handler.options), fn);
      continue;
    }

    shared[name] = createWorkflowSharedHandler(sdkOptions(handler.options), fn);
  }

  if (!run) {
    throw new Error(
      `${className} is bound as workflow '${binding.name}' but has no 'run' handler, which is the workflow itself.`,
    );
  }

  return workflow({ ...named(binding), handlers: { ...shared, run } });
}

/** What every kind carries besides its handlers. */
function named(binding: RestateBinding) {
  const { name, description, metadata, options } = binding;
  return { name, description, metadata, options };
}

/** The one handler name Restate reserves a meaning for. */
const WORKFLOW_ENTRY = 'run';

/**
 * Puts a handler's options back into the type the SDK factories expect.
 *
 * The generics they carry describe one handler's input and output, and are
 * erased by the time metadata is read back — see `ErasedHandlerOptions`. This
 * is where that is paid for, once, rather than at each of the five call sites.
 */
function sdkOptions(options: ErasedHandlerOptions): Parameters<typeof createServiceHandler>[0] {
  return options as Parameters<typeof createServiceHandler>[0];
}
