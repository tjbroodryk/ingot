import type { IngotConfig } from '@ingot/shared/ingot-v1';
import { AggregateRoot, ConflictingState, Guard } from '../../../shared/domain/index.js';
import { Delivery } from './delivery.vo.js';
import { IngotId } from './ingot-id.vo.js';
import { Retention } from './retention.vo.js';

/**
 * The vector space a memory's embeddings live in.
 *
 * Recorded on the memory rather than read from configuration at query time,
 * because a stored vector is only meaningful next to vectors from the same
 * model. `INGOT_EMBEDDER` is a property of the process; this is a property of
 * the data, and the two stop agreeing the moment somebody changes the first.
 */
export interface EmbeddingSpace {
  readonly model: string;
  readonly dimensions: number;
}

interface IngotProps {
  accountId: string;
  name: string;
  createdAt: Date;
  /** When this memory falls due for deletion. Null is kept indefinitely. */
  expiresAt: Date | null;
  /** Set by the first embedding written. Null until then. */
  embedding: EmbeddingSpace | null;
  /** Where this memory's receipts are pushed. `none` until configured. */
  delivery: Delivery;
}

/**
 * One memory.
 *
 * Deliberately thin. Everything interesting about an ingot — what tables it
 * has, what shape they are, where their Parquet lives — belongs to the tables
 * themselves, because that is the granularity writes contend at. This holds
 * only what is true of the memory as a whole, which is who owns it and what it
 * is called.
 */
export class Ingot extends AggregateRoot<IngotId> {
  private props: IngotProps;

  private constructor(id: IngotId, props: IngotProps, version = 0) {
    super(id, version);
    this.props = props;
  }

  static cast(input: { accountId: string; name: string; retainFor?: string; now: Date }): Ingot {
    // Parsed here rather than by the caller, so that both the HTTP surface and
    // the MCP one — which builds the same command without passing through a
    // validation pipe — get the same answer to what `14d` means.
    const retention = input.retainFor ? Retention.of(input.retainFor) : null;

    return new Ingot(IngotId.generate(), {
      accountId: input.accountId,
      name: Guard.maxLength(Guard.notBlank(input.name, 'ingot.name'), 120, 'ingot.name'),
      createdAt: input.now,
      expiresAt: retention ? retention.from(input.now) : null,
      // Not chosen at creation. A memory that never embeds anything never
      // acquires one, and a memory that does acquires whichever model was
      // configured when its first vector was written.
      embedding: null,
      // Nor is this. Receipts are collected by the SELECT `/add` hands back
      // until somebody nominates somewhere to push them to, which is a second
      // call rather than a field on `create` — a delivery target is a property
      // of the system holding the memory, not of the moment it was cast.
      delivery: Delivery.none(),
    });
  }

  static rehydrate(id: IngotId, props: IngotProps, version: number): Ingot {
    return new Ingot(id, props, version);
  }

  get accountId(): string {
    return this.props.accountId;
  }
  get name(): string {
    return this.props.name;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  /** When this memory falls due for deletion. Null is kept indefinitely. */
  get expiresAt(): Date | null {
    return this.props.expiresAt;
  }

  /**
   * Whether this memory is past its retention.
   *
   * Asked by the reaper immediately before it deletes, and not only by the
   * query that selected it. A row selected as expired and deleted several
   * seconds later is a row nothing re-checked, and the thing on the other end
   * of that is irreversible.
   */
  hasExpired(now: Date): boolean {
    return this.props.expiresAt !== null && this.props.expiresAt.getTime() <= now.getTime();
  }

  /** Whether this ingot is the given account's. The tenancy check, once. */
  belongsTo(accountId: string): boolean {
    return this.props.accountId === accountId;
  }

  /** Where this memory's receipts are pushed. `none` until configured. */
  get delivery(): Delivery {
    return this.props.delivery;
  }

  /** Everything configurable about this memory, defaults included. */
  get config(): IngotConfig {
    return { delivery: this.props.delivery.toWire() };
  }

  /**
   * Applies a caller's patch, and says whether anything moved.
   *
   * A patch, so an absent field keeps what is already set: a config call sent
   * to change one thing must not quietly undo another, which is what makes an
   * endpoint like this safe to call twice. Turning delivery off is therefore
   * `{ t: "none" }` and not an omission.
   *
   * The boolean is what stops a no-op taking the aggregate's version. Saving
   * for a patch that changed nothing makes whatever is writing to this memory
   * right now lose an optimistic-concurrency race for no reason at all.
   */
  configure(patch: { readonly delivery?: unknown }): boolean {
    if (patch.delivery === undefined) return false;

    const delivery = Delivery.of(patch.delivery);
    if (delivery.equals(this.props.delivery)) return false;

    this.props.delivery = delivery;
    return true;
  }

  /** The vector space this memory's embeddings live in. Null until the first. */
  get embedding(): EmbeddingSpace | null {
    return this.props.embedding;
  }

  /**
   * Claims a vector space for this memory, on the first embedding written.
   *
   * Idempotent for the same model at the same width, and a conflict for any
   * other — which is the point. Cosine similarity between vectors from two
   * different models is a number, and it means nothing; a memory that quietly
   * accumulated both would return rankings that are wrong in a way no error
   * ever surfaces and no test would catch. So the first write decides, and
   * everything afterwards is held to it.
   *
   * Changing model is therefore not a configuration change — it is a re-embed,
   * which is what the `Embedder` port has always said and what nothing until
   * now enforced.
   */
  useEmbedding(space: EmbeddingSpace): void {
    const current = this.props.embedding;

    if (current === null) {
      this.props.embedding = space;
      return;
    }
    if (current.model === space.model && current.dimensions === space.dimensions) return;

    throw new ConflictingState(
      `this memory is embedded with "${current.model}" at ${current.dimensions} dimensions, ` +
        `and this deployment is configured for "${space.model}" at ${space.dimensions}. ` +
        'Vectors from two models cannot be compared, so mixing them would silently corrupt ' +
        'every ranking. Point INGOT_EMBEDDER back at the original model, or drop this memory ' +
        'and store it again to re-embed it.',
    );
  }

  /**
   * Refuses a question embedded by the wrong model.
   *
   * The read half of `useEmbedding`. A memory with no embeddings has nothing
   * to be incompatible with, so it accepts anything — the first write is what
   * decides.
   */
  assertEmbeddingMatches(space: EmbeddingSpace): void {
    if (this.props.embedding === null) return;
    this.useEmbedding(space);
  }
}
