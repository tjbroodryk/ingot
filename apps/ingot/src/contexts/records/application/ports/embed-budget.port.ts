/**
 * The embedder's rate limit, shared across replicas.
 *
 * Every replica drains the queue, so a quota held in one process is a quota
 * each of the others spends again.
 */
export interface EmbedBudget {
  /** Whether a rate limit has stopped embedding at `now`. */
  paused(now: Date): Promise<boolean>;

  /**
   * Takes `tokens` from this minute's budget. False when paused, or when the
   * window has no room left; a request into an empty window always fits.
   */
  reserve(tokens: number, now: Date): Promise<boolean>;

  /** Stops every replica until `until`; an earlier pause never shortens a later one. */
  pause(until: Date): Promise<void>;
}

export const EMBED_BUDGET = Symbol('EmbedBudget');
