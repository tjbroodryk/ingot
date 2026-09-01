-- When a memory falls due for deletion.
--
-- Null for the overwhelming majority: a memory is kept until something deletes
-- it, and expiry is opt-in because what it does is irreversible. A caller sets
-- it by saying how long — `14d` — rather than by naming a timestamp, so that
-- the arithmetic that turns "two weeks" into an instant happens once, here,
-- rather than in every client.
--
-- The index is partial for the same reason the column is nullable: the reaper's
-- query is only ever interested in rows that have a value, and indexing the
-- nulls would be indexing almost the whole table to find almost none of it.

ALTER TABLE ingot
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS ingot_expiring
  ON ingot (expires_at) WHERE expires_at IS NOT NULL;
