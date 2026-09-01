-- The hot tier: rows accepted but not yet rolled up into Parquet.
--
-- `payload` keys are already the declared column names and its values are
-- already coerced to the declared types — that work happens at /add, where the
-- caller can still fix it. Projecting this into DuckDB is therefore mechanical
-- and driven by the manifest, rather than a second round of guessing at JSON.
--
-- `seq` is the point of the table. A roll-up reads to a watermark and deletes
-- to the same watermark, so rows written while the Parquet is being produced
-- are neither in the file nor lost. Without it, that window swallows writes.

CREATE TABLE IF NOT EXISTS overlay_row (
  seq          bigserial   PRIMARY KEY,
  ingot_id     text        NOT NULL,
  table_id     text        NOT NULL,
  row_id       text        NOT NULL,
  payload      jsonb       NOT NULL,
  ingested_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS overlay_row_table_seq ON overlay_row (table_id, seq);
CREATE INDEX IF NOT EXISTS overlay_row_ingot ON overlay_row (ingot_id);

ALTER TABLE overlay_row DROP CONSTRAINT IF EXISTS overlay_row_identity;
ALTER TABLE overlay_row ADD CONSTRAINT overlay_row_identity UNIQUE (table_id, row_id);

-- Forgotten rows. A tombstone rather than a delete, because the row may
-- already be inside a Parquet file and Parquet is not edited in place. Every
-- read filters against this set; the next roll-up drops the row for good.
CREATE TABLE IF NOT EXISTS overlay_tombstone (
  table_id  text        NOT NULL,
  row_id    text        NOT NULL,
  at        timestamptz NOT NULL,
  PRIMARY KEY (table_id, row_id)
);

-- Vectors for overlay rows. real[] rather than a blob because the overlay is
-- small by design — anything large has been rolled up into the sibling
-- Parquet, which is where vectors live at rest. model and dims are recorded so
-- that changing embedding model is a thing that can be noticed rather than a
-- silent mixing of two vector spaces in one ranking.
CREATE TABLE IF NOT EXISTS overlay_vector (
  table_id     text    NOT NULL,
  row_id       text    NOT NULL,
  column_name  text    NOT NULL,
  model        text    NOT NULL,
  dims         integer NOT NULL,
  vector       real[]  NOT NULL,
  PRIMARY KEY (table_id, row_id, column_name)
);

-- What still needs embedding. An explicit queue rather than a left join
-- against overlay_vector, because the column to embed differs per table and
-- deriving it would mean joining the manifest into a hot query.
CREATE TABLE IF NOT EXISTS overlay_embed_queue (
  table_id     text        NOT NULL,
  row_id       text        NOT NULL,
  column_name  text        NOT NULL,
  text         text        NOT NULL,
  queued_at    timestamptz NOT NULL,
  PRIMARY KEY (table_id, row_id, column_name)
);

CREATE INDEX IF NOT EXISTS overlay_embed_queue_age ON overlay_embed_queue (queued_at);
