-- Which roll-up worker holds a due table, and until when.
--
-- A roll-up used to run one at a time under an advisory lock. Now each worker
-- claims its tables here: `claim` is a token only the claimant knows, and
-- `claimed_until` is a lease it renews while it works. Another worker skips a
-- claimed table until the lease lapses, and a roll-up publishes only while its
-- token is still the one on the row — so a worker that stalled past its lease
-- cannot publish over the one that took the table from it.

ALTER TABLE roll_up_due
  ADD COLUMN IF NOT EXISTS claim text,
  ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
