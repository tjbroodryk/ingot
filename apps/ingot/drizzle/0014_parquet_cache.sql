-- The shared Parquet cache's index: which files are on the shared volume, their
-- size, and when each was cached and last read. `object_key` lets a deleted
-- table or ingot expire everything under its prefix.

CREATE TABLE IF NOT EXISTS parquet_cache_file (
  id            text        PRIMARY KEY,
  object_key    text        NOT NULL,
  bytes         bigint      NOT NULL,
  cached_at     timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS parquet_cache_file_last_used ON parquet_cache_file (last_used_at);
CREATE INDEX IF NOT EXISTS parquet_cache_file_key ON parquet_cache_file (object_key text_pattern_ops);
