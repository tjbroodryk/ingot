import type { IngotConfig } from '@ingot/shared/ingot-v1';
import { AggregateRoot, ConflictingState, Guard } from '../../../shared/domain/index.js';
import { Delivery } from './delivery.vo.js';
import { IngotId } from './ingot-id.vo.js';
import { Retention } from './retention.vo.js';

/** The vector space a memory's embeddings live in; recorded on the memory, not read at query time. */
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

/** One memory. Thin: table schemas and data belong to the tables, which is where writes contend. */
export class Ingot extends AggregateRoot<IngotId> {
  private props: IngotProps;

  private constructor(id: IngotId, props: IngotProps, version = 0) {
    super(id, version);
    this.props = props;
  }

  static cast(input: { accountId: string; name: string; retainFor?: string; now: Date }): Ingot {
    // Parsed here so both the HTTP and MCP surfaces agree on what `14d` means.
    const retention = input.retainFor ? Retention.of(input.retainFor) : null;

    return new Ingot(IngotId.generate(), {
      accountId: input.accountId,
      name: Guard.maxLength(Guard.notBlank(input.name, 'ingot.name'), 120, 'ingot.name'),
      createdAt: input.now,
      expiresAt: retention ? retention.from(input.now) : null,
      // Acquired on the first embedding written, not at creation.
      embedding: null,
      // Set by a later config call, not at creation.
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

  /** Whether this memory is past its retention. */
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

  /** Applies a patch; returns whether anything moved. Absent fields keep their current value. */
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
   * Claims a vector space on the first embedding. Idempotent for the same model
   * and width; any other is a conflict — vectors from two models cannot be compared.
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

  /** The read half of `useEmbedding`: refuses a query embedded by the wrong model. */
  assertEmbeddingMatches(space: EmbeddingSpace): void {
    if (this.props.embedding === null) return;
    this.useEmbedding(space);
  }
}
