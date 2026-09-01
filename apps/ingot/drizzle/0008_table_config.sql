-- How a table is searched, held beside its schema.
--
-- Full text search is DuckDB's `fts` extension, and its index is built from
-- arguments that have to be the same at both ends: an index built with the
-- English stopword list and searched by a term that kept its stopwords ranks
-- on tokens the index does not contain, and reports that as no results rather
-- than as a mistake. So the settings belong to the table, not to the query.
--
-- A document rather than a column each. These are knobs on how rows are read,
-- nothing is ever selected on them, and the next one should be a field in the
-- code rather than another migration.
--
-- Nullable, with no default. A table nobody has configured reads the defaults
-- the code holds — a default written into the row would go on claiming a value
-- the code has since moved on from, for every table that already exists.

ALTER TABLE ingot_table
  ADD COLUMN IF NOT EXISTS config jsonb;
