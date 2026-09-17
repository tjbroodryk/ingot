-- The caller's own handle for an ingot — a conversation id, a job id.
--
-- What makes create idempotent. Two workers opening the ingot for the same
-- conversation used to make two, and one of them became an orphan nobody
-- addressed; with this, the second create finds the first one's ingot.
--
-- Unique per account, and only where set: most ingots have no handle, and
-- two accounts may use the same one. The index is what settles a race — the
-- losing insert conflicts, does nothing, and reads the winner's row.

ALTER TABLE ingot
  ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ingot_account_external_id
  ON ingot (account_id, external_id) WHERE external_id IS NOT NULL;
