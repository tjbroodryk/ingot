-- Telling somebody a receipt is ready, without lying about it.
--
-- Until now a receipt was collected by polling: /add hands back a SELECT and
-- the caller runs it when it wants the answer. That needs no registration, no
-- retry policy and no endpoint to be up — but it is a poor fit for an agent
-- that has moved on and would rather be told.
--
-- Two things arrive together here, and they are two halves of one property.
--
-- `ingot.delivery` is WHERE. A strategy per memory, as the document the caller
-- sent — {"t":"webhook","endpoint":"…"} or {"t":"rmq","queue":"…"} — because
-- the thing that wants telling is the system holding the memory, not the
-- individual /add. Nullable with no default: a memory nobody has configured
-- reads the code's default (`none`), and a default written into the row is one
-- that goes on claiming a value the code has since moved on from.
--
-- `receipt_delivery_queue` is HOW, and it is an outbox rather than a call. The
-- row is written in the SAME transaction as the receipt it announces, so the
-- two are atomic: there is no state in which a summary exists and nothing will
-- ever mention it, and none in which something was announced that a rollback
-- then took away. The sending happens afterwards, outside any transaction,
-- from a worker — which is the whole reason this table exists rather than a
-- `fetch` in the command. A push delivered from inside a transaction is a
-- claim about state that may still be rolled back, and nothing outside the
-- database rolls back with it.
--
-- The shape is `overlay_receipt_queue`'s, deliberately, because the failure
-- modes are the same ones:
--
--   `claimed_at` is a lease, not a row lock, because the work does not happen
--   inside one transaction. A delivery is claimed, somebody else's HTTP
--   endpoint or broker is called, and the outcome is written — three steps
--   with a network call in the middle. Holding a connection across that would
--   spend a pool of ten on background work while the foreground is trying to
--   answer. The lease expires so a worker that died mid-call does not strand
--   the row.
--
--   `attempts` is incremented AT CLAIM, not on failure. A worker killed by the
--   very delivery it is making never reaches a failure handler, so a counter
--   written there would never move and that row would be retried for ever.
--
--   A row that runs out of attempts stays here with `last_error` on it — out of
--   the worker's way, and in front of anybody who goes looking for why a
--   webhook never arrived.
--
-- `target` is resolved AT ENQUEUE and stored on the row rather than read from
-- `ingot.delivery` at delivery time. A memory whose endpoint is changed while
-- a delivery is in flight should not have that delivery silently retargeted at
-- the new one — the row records where it was going when it was announced.

ALTER TABLE ingot
  ADD COLUMN IF NOT EXISTS delivery jsonb;

CREATE TABLE IF NOT EXISTS receipt_delivery_queue (
  -- The receipt's batch. One delivery per receipt, so this is its identity and
  -- a re-announcement of the same receipt collapses onto the same row rather
  -- than sending twice.
  batch         text        PRIMARY KEY,
  ingot_id      text        NOT NULL,
  -- Where it was going when it was announced. A `DeliveryStrategy` document.
  target        jsonb       NOT NULL,
  -- The body to send, rendered when the receipt was written: a
  -- `DeliveredReceipt`. Kept whole rather than rebuilt at delivery time,
  -- because rebuilding means re-reading rows that a tombstone or a roll-up may
  -- have moved since — and a delivery should say what was true when the
  -- receipt landed.
  payload       jsonb       NOT NULL,
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,
  claimed_at    timestamptz,
  queued_at     timestamptz NOT NULL
);

-- Leading on `attempts` because every claim filters on it before ordering by
-- age: the rows that have run out are dead weight the worker should never walk
-- past, and there is no bound on how many of them accumulate.
CREATE INDEX IF NOT EXISTS receipt_delivery_queue_age
  ON receipt_delivery_queue (attempts, claimed_at, queued_at);

-- Destroying a memory destroys its undelivered announcements with it.
CREATE INDEX IF NOT EXISTS receipt_delivery_queue_ingot
  ON receipt_delivery_queue (ingot_id);
