-- The embedder's quota, shared by every replica.
--
-- One row. `tokens_used` is what has been sent in the minute from
-- `window_start`, and a request that would take it past INGOT_EMBEDDINGS_TPM
-- waits for the next window. `paused_until` is set by a 429 and stops every
-- replica calling the embedder until the host's retry-after has passed.
--
-- The row is written on first use, so there is nothing to seed.

CREATE TABLE IF NOT EXISTS embed_budget (
  id            boolean     PRIMARY KEY DEFAULT true CHECK (id),
  window_start  timestamptz NOT NULL,
  tokens_used   bigint      NOT NULL,
  paused_until  timestamptz
);
