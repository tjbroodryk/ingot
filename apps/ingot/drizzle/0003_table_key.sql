-- What identifies a row, as the caller sees it.
--
-- A receipt hands back a query that finds a stored item again, and doing that
-- on our own `_row_id` or `_batch` is only useful until the caller forgets
-- them. A key named in the caller's own terms — `["pr", "path"]` — still means
-- something next week, and still matches after the same item is stored again.
--
-- Declarative only. Nothing deduplicates on it and nothing refuses a second row
-- with the same key; it says what identifies the thing, not that the thing is
-- unique. Upserting on it is the obvious next step and is not built.
--
-- `key_columns` rather than `key`: KEY is reserved in enough dialects that the
-- shorter name is a trap for whoever writes the next raw query by hand.

ALTER TABLE ingot_table
  ADD COLUMN IF NOT EXISTS key_columns jsonb NOT NULL DEFAULT '[]'::jsonb;
