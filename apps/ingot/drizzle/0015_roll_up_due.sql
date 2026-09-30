-- When each table with something in its overlay is next due a roll-up.
--
-- The first write to a table with no row here schedules it for
-- INGOT_ROLLUP_INTERVAL_MS later; reaching INGOT_ROLLUP_MIN_ROWS brings it
-- forward to now. The roll-up sweep polls this by `due_at`, which is what lets
-- it run every few seconds without grouping the whole overlay to find its work.
--
-- A roll-up rewrites the row from what is left in the overlay afterwards, or
-- deletes it when nothing is. A write that commits while that happens can be
-- left without a row, since the roll-up cannot see it yet; a slower sweep
-- schedules any table with overlay rows or tombstones and no row here.

CREATE TABLE IF NOT EXISTS roll_up_due (
  table_id  text        PRIMARY KEY,
  due_at    timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS roll_up_due_at ON roll_up_due (due_at);

-- What was already waiting, at the default interval from its oldest row.
INSERT INTO roll_up_due (table_id, due_at)
SELECT table_id, min(at) + interval '5 minutes'
FROM (
  SELECT table_id, ingested_at AS at FROM overlay_row
  UNION ALL
  SELECT table_id, at FROM overlay_tombstone
) waiting
GROUP BY table_id
ON CONFLICT (table_id) DO NOTHING;
