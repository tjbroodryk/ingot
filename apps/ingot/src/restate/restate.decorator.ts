import { Injectable, SetMetadata, applyDecorators } from '@nestjs/common';
import type {
  ObjectHandlerOpts,
  ObjectOptions,
  ServiceOptions,
  WorkflowOptions,
} from '@restatedev/restate-sdk';

export const RESTATE_BINDING_METADATA = 'restate:binding';
export const RESTATE_HANDLER_METADATA = 'restate:handler';

/**
 * The three things Restate can serve, which differ in what they promise about
 * concurrency rather than in how they are written.
 *
 * - **Service** — stateless. Every invocation runs concurrently with every
 *   other; a webhook receiver is one.
 * - **Virtual object** — keyed, with state. Invocations against one key are
 *   serialised, which is the guarantee you reach for when two deliveries about
 *   the same pull request must not interleave.
 * - **Workflow** — a virtual object whose `run` executes exactly once per key,
 *   for a long-lived process with a beginning and an end.
 *
 * A string enum rather than a union because these values cross into the
 * discovery manifest and are switched on when the endpoint is built; see
 * `CLAUDE.md` on why a closed set is an enum here.
 */
export enum RestateKind {
  Service = 'service',
  VirtualObject = 'virtual_object',
  Workflow = 'workflow',
}

/** Everything the SDK accepts at the service level, whatever the kind. */
type BindingOptions = ServiceOptions & ObjectOptions & WorkflowOptions;

/** What a decorated class says about itself, read back at endpoint build. */
export interface RestateBinding {
  readonly kind: RestateKind;
  /** The name Restate knows it by, and the first segment of its ingress path. */
  readonly name: string;
  /** Shown in the UI and the admin API. */
  readonly description?: string;
  readonly metadata?: Record<string, string>;
  readonly options?: BindingOptions;
}

interface BindingSpec<O> {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
  /** Retention, timeouts, retry policy, privacy — see the SDK's own docs. */
  options?: O;
}

/**
 * Serves a class's decorated methods as a Restate service.
 *
 * ```ts
 * @RestateService({ name: 'github-webhooks' })
 * export class GithubWebhooks {
 *   constructor(private readonly dispatcher: Dispatcher) {}
 *
 *   @RestateHandler()
 *   async delivery(ctx: Context, payload: unknown): Promise<void> { … }
 * }
 * ```
 *
 * The class is an ordinary Nest provider — this decorator applies
 * `@Injectable()` — so a handler reaches the dispatcher, a repository or
 * anything else the container holds by asking for it in the constructor. That
 * is the entire point of registering services this way rather than calling
 * `restate.service({ … })` at module scope: a free-standing definition has
 * nowhere to inject anything from, and ends up either importing the container
 * or growing its own.
 *
 * Add it to a module's `providers` like any other class. `RestateServices`
 * finds it through Nest's own discovery, so there is no second list to keep,
 * and a service dropped from its module stops being served on the same commit.
 */
export function RestateService(spec: BindingSpec<ServiceOptions>): ClassDecorator {
  return bind({ kind: RestateKind.Service, ...spec });
}

/**
 * Serves a class as a virtual object: state per key, one invocation at a time.
 *
 * The handlers take an `ObjectContext`, whose `get`/`set` read and write state
 * scoped to the key in the invocation's path — `/repo-sync/acme%2Fweb/push`
 * addresses the object keyed `acme/web`. Restate serialises exclusive
 * invocations per key, which is a lock you get by asking for it rather than
 * one you have to hold correctly.
 */
export function RestateObject(spec: BindingSpec<ObjectOptions>): ClassDecorator {
  return bind({ kind: RestateKind.VirtualObject, ...spec });
}

/**
 * Serves a class as a workflow: one `run` per key, ever.
 *
 * `run` is required and is the workflow itself. Every other handler is a
 * shared one — a way to look at, or signal, a run in progress — and the
 * registry marks them so; declaring `shared` on them is unnecessary and on
 * `run` it is an error.
 */
export function RestateWorkflow(spec: BindingSpec<WorkflowOptions>): ClassDecorator {
  return bind({ kind: RestateKind.Workflow, ...spec });
}

function bind(binding: RestateBinding): ClassDecorator {
  return applyDecorators(Injectable(), SetMetadata(RESTATE_BINDING_METADATA, binding));
}

/**
 * Per-handler options with the serde type parameters erased.
 *
 * `Serde<T>` is invariant — it both consumes and produces a `T` — so there is
 * no single instantiation of the SDK's options type that holds every handler's.
 * The decorator stays generic, where a call site has both types in hand; what
 * survives into metadata is this, and `service-registry.ts` casts it back once
 * on the way into the SDK.
 */
export type ErasedHandlerOptions = Record<string, unknown>;

/** What a decorated method says about itself. */
export interface RestateHandlerBinding {
  /** The method's own name unless overridden. */
  readonly name: string;
  /** Concurrent, read-only access to one key. Objects and workflows only. */
  readonly shared: boolean;
  readonly options: ErasedHandlerOptions;
}

interface RestateHandlerSpec<I, O> extends ObjectHandlerOpts<I, O> {
  /**
   * The name Restate knows this handler by, and the second segment of its
   * ingress path. Defaults to the method name, which is what you want unless
   * a rename would otherwise break a URL somebody else already configured.
   */
  name?: string;
  /**
   * Run concurrently with other invocations for the same key, without the
   * right to write state.
   *
   * Meaningless on a service, where nothing is keyed and everything is already
   * concurrent — the registry refuses it there rather than accepting a flag
   * that does nothing.
   */
  shared?: boolean;
}

/**
 * A method decorator that only applies to something shaped like a handler.
 *
 * `never` in the parameter positions makes the check contravariantly harmless
 * — every parameter list accepts `never` — while the return position still
 * has to be a promise. So a synchronous method, or one that forgot the
 * context, does not compile; matching how `@Observed` types its target.
 */
type Handling = <M extends (ctx: never, input: never) => Promise<unknown>>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<M>,
) => void;

/**
 * Exposes one method of a bound class as a Restate handler.
 *
 * ```ts
 * @RestateHandler()                                   // named for the method
 * @RestateHandler({ name: 'delivery' })               // named explicitly
 * @RestateHandler({ shared: true })                   // read-only, concurrent
 * @RestateHandler({ ingressPrivate: true })           // callable only by peers
 * @RestateHandler({ retryPolicy: { maxAttempts: 3 } })
 * ```
 *
 * Anything the SDK accepts per handler is accepted here and passed through
 * untouched — retention, timeouts, serdes, the retry policy. What is *not*
 * passed through is anything this file made up, because a handler's behaviour
 * should be searchable in Restate's documentation rather than in ours.
 *
 * An undecorated method is a helper: the class keeps it, Restate never sees it.
 */
export function RestateHandler<I = unknown, O = unknown>(
  spec: RestateHandlerSpec<I, O> = {},
): Handling {
  const { name, shared, ...options } = spec;

  return (_target, propertyKey, descriptor) => {
    if (!descriptor.value) return;

    Reflect.defineMetadata(
      RESTATE_HANDLER_METADATA,
      {
        name: name ?? String(propertyKey),
        shared: shared === true,
        options: options as ErasedHandlerOptions,
      } satisfies RestateHandlerBinding,
      descriptor.value,
    );
  };
}

// ── reading it back ───────────────────────────────────────────────────────

/**
 * What a class declared, if it declared anything.
 *
 * Own metadata rather than inherited, so that extending a bound service does
 * not quietly produce a second class claiming the same name.
 */
export function readRestateBinding(target: object): RestateBinding | null {
  return (
    (Reflect.getOwnMetadata(RESTATE_BINDING_METADATA, target) as RestateBinding | undefined) ?? null
  );
}

export function readRestateHandler(method: object): RestateHandlerBinding | null {
  return (
    (Reflect.getMetadata(RESTATE_HANDLER_METADATA, method) as RestateHandlerBinding | undefined) ??
    null
  );
}
