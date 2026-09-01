-- What still needs describing.
--
-- One row per /add that asked for `receipt: "summary"`, holding the caller's
-- tool result until a model has read it and written a receipt. The body is kept
-- here rather than re-read from the overlay because a mapping projects a blob
-- into typed columns and throws the rest away — `raw: true` is opt-in, and
-- asking for a summary should not require it.
--
-- The receipt itself does not live here. It is written into the memory's own
-- `_receipt` table, which means it gets the overlay, the embedding sweeper, the
-- roll-up into Parquet, tombstones and `/query` from machinery that already
-- exists. This table is only the work not yet done.
--
-- `claimed_at` is a lease, and it is a lease rather than a row lock because
-- the work does not happen inside one transaction. A receipt is claimed, a
-- model is asked, and the answer is written — three steps with a network call
-- in the middle, and holding a connection across that would spend a pool of
-- ten on background work while the foreground is trying to answer. So the
-- claim commits, the lease says "somebody is on this", and it expires so that
-- a worker which died mid-call does not strand the row forever.
--
-- `attempts` is incremented AT CLAIM, not on failure. That is the difference
-- between a poison body that stops after four tries and one that loops for
-- ever: a process killed by the very result it is describing never reaches a
-- failure handler, so a counter written there would never move.
--
-- A row that runs out of attempts stays here with `last_error` on it — out of
-- the sweeper's way, and in front of anybody who goes looking for why a
-- summary never arrived.

CREATE TABLE IF NOT EXISTS overlay_receipt_queue (
  batch         text        PRIMARY KEY,
  external_id   text,
  ingot_id      text        NOT NULL,
  table_id      text        NOT NULL,
  source_table  text        NOT NULL,
  body          jsonb       NOT NULL,
  rows          integer     NOT NULL,
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,
  claimed_at    timestamptz,
  queued_at     timestamptz NOT NULL
);

-- Leading on `attempts` because every claim filters on it before ordering by
-- age: the rows that have run out are dead weight the sweeper should never
-- walk past, and there is no bound on how many of them accumulate.
CREATE INDEX IF NOT EXISTS overlay_receipt_queue_age
  ON overlay_receipt_queue (attempts, claimed_at, queued_at);

-- Destroying a memory destroys its pending work with it.
CREATE INDEX IF NOT EXISTS overlay_receipt_queue_ingot
  ON overlay_receipt_queue (ingot_id);
