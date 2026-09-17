-- Parquet generations that have been replaced, and when each may be deleted.
--
-- A roll-up used to delete the generation two behind it straight after the
-- commit. That was enough grace for a query, which reads the files it resolved
-- within fifteen seconds. It is not enough for a caller downloading a table
-- through `/parquet` and then paging `/pending` against it, or a DuckDB reading
-- column chunks by range over minutes — and how long that is depends on how
-- often the table is written to, which is nothing a caller can see.
--
-- So a replaced generation is retired here with a time, and a sweep deletes it
-- once that has passed: `INGOT_GENERATION_GRACE_MS`, the same for every table.
--
-- A dropped table or a deleted memory takes its rows with it. A table recreated
-- under the same name counts its generations from one again, and a retirement
-- left over from the old one would delete the new table's files.

CREATE TABLE IF NOT EXISTS retired_generation (
  prefix       text        PRIMARY KEY,
  ingot_id     text        NOT NULL,
  table_id     text        NOT NULL,
  generation   integer     NOT NULL,
  reap_after   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS retired_generation_due ON retired_generation (reap_after);
CREATE INDEX IF NOT EXISTS retired_generation_table ON retired_generation (table_id);
CREATE INDEX IF NOT EXISTS retired_generation_ingot ON retired_generation (ingot_id);
