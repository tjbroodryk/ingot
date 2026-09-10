-- The manifest: what a memory is, and what shape its tables are.
--
-- `ingot` is thin on purpose. Everything interesting about a memory belongs to
-- its tables, because that is the granularity writes contend at — two tools
-- writing two tables of one memory must never make each other retry, so the
-- optimistic-concurrency version lives on `ingot_table` and not here.
--
-- `generation` counts roll-ups and is not the same thing as `version`: a
-- compaction bumps both, a schema change bumps only the version. It is in the
-- object key as well as here, which is what lets generation n+1 be published
-- while queries are still reading n.

CREATE TABLE IF NOT EXISTS ingot (
  id          text        PRIMARY KEY,
  account_id  text        NOT NULL,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL,
  version     integer     NOT NULL
);

CREATE INDEX IF NOT EXISTS ingot_account ON ingot (account_id, created_at);

CREATE TABLE IF NOT EXISTS ingot_table (
  id            text        PRIMARY KEY,
  ingot_id      text        NOT NULL,
  name          text        NOT NULL,
  columns       jsonb       NOT NULL,
  base_files    jsonb       NOT NULL,
  vector_files  jsonb       NOT NULL,
  generation    integer     NOT NULL,
  base_rows     integer     NOT NULL,
  created_at    timestamptz NOT NULL,
  version       integer     NOT NULL
);

-- The natural key, as a constraint rather than as the primary key: the
-- aggregate has a version and the write guards on a single column.
--
-- 0010 drops this again and re-creates it as a plain index, for a race it was
-- losing. Left here because a database that has already run this migration
-- holds the constraint, and 0010 is what takes it off.
ALTER TABLE ingot_table DROP CONSTRAINT IF EXISTS ingot_table_name;
ALTER TABLE ingot_table ADD CONSTRAINT ingot_table_name UNIQUE (ingot_id, name);

CREATE INDEX IF NOT EXISTS ingot_table_ingot ON ingot_table (ingot_id);

-- No foreign key from ingot_table to ingot. Deleting a memory deletes its
-- tables in the same transaction, and a cascade would make that implicit
-- rather than something the repository is seen to do.
