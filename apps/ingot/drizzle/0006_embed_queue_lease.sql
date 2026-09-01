-- A lease on the embedding queue.
--
-- The queue itself is from 0002 and has always worked; what it never had was a
-- way to say "somebody is already embedding these". That was invisible while
-- the default embedder ran in-process and finished in microseconds. It stops
-- being invisible the moment INGOT_EMBEDDER names a hosted model: a batch of
-- 128 texts is now an HTTP round trip, and the work no longer happens inside
-- the transaction that claimed it — it cannot, because holding a Postgres
-- connection across somebody else's API is how a background job takes the
-- foreground down with it.
--
-- Without a lease, two things go wrong once the work is slow. A second replica
-- claims the same rows and buys the same vectors twice, and a batch that takes
-- longer than the sweep interval is re-claimed by the next tick while the
-- first is still in flight. Neither corrupts anything — saving a vector is an
-- upsert keyed on the row — but both are paid for.
--
-- Nullable, and no backfill: an unclaimed row is one nobody is working on,
-- which is exactly what every existing row is.

ALTER TABLE overlay_embed_queue
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- The claim reads oldest-unleased-first, so the lease has to be in the index
-- ahead of the age or every claim walks the rows already in flight.
DROP INDEX IF EXISTS overlay_embed_queue_age;
CREATE INDEX IF NOT EXISTS overlay_embed_queue_age
  ON overlay_embed_queue (claimed_at, queued_at);
