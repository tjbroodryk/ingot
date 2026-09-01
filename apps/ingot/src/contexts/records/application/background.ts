/**
 * The durable work `/add` sets off, and how to reach it.
 *
 * **A delivery is the fast path and a sweep is the floor** — the rule
 * `CLAUDE.md` gives webhooks, applied to our own writes. A row that has just
 * been stored should be embedded now, not within a minute, because that minute
 * is latency a caller experiences: they store something and it is not findable
 * by meaning until a timer happens to fire.
 *
 * So `/add` sends into Restate the moment its transaction commits, and the
 * cron chain stays exactly as it was. The sweep is not redundant — it is what
 * covers the send that never went, and there are exactly two ways for that to
 * happen. The send is made from `uow.afterCommit`, which catches and logs, so
 * an ingress that refuses or times out leaves the queue row behind and no
 * error anywhere a caller can see; and the send is not itself journalled, so a
 * process that dies between the COMMIT and the POST leaves the same row with
 * nobody told about it. One is the fast path, the other is the floor, and both
 * invoke the same handler, so they cannot disagree about what the work is.
 *
 * What is *not* on that list is a deployment with durable execution turned
 * off. There is no such deployment and no switch for one — see
 * `restate/config.ts`.
 *
 * Rolling the overlay up into Parquet is deliberately **not** here. That one is
 * genuinely periodic: it wants to batch, its whole value is amortising a file
 * rewrite over many rows, and triggering it per write would produce a
 * generation per `/add` — which is the opposite of what a compaction is for.
 *
 * The names live here rather than in `sweepers/` because both the
 * `@RestateCron` decorator and the sender need them, and `sweepers/` already
 * depends on this context. One definition, so a rename cannot leave `/add`
 * sending at a service that no longer answers.
 */

/** Works the embedding backlog. `sweep-embeddings/now/send` triggers it. */
export const EMBEDDING_SERVICE = 'sweep-embeddings';

/** Writes the receipts `receipt: "summary"` promised. */
export const RECEIPT_SERVICE = 'sweep-receipts';

/**
 * The handler that works the queue once and does not book a next tick.
 *
 * A second handler rather than invoking `tick`, because `tick` extends the
 * cron chain as its last act. Triggering that per write would give a memory
 * under load one chain per `/add`, each booking another, for ever.
 */
export const RUN_NOW = 'now';
