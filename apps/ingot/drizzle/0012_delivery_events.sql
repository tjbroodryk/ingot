-- Table events share the receipt outbox, and fold while they wait.
--
-- `operations.appended`, `table.rolled_up` and `table.dropped` go out through
-- the same transactional outbox as `receipt.ready`, for the same reason: the
-- intention to announce commits with the write it announces. What differs is
-- how many there are. A table written to in a loop would queue one delivery per
-- write, so an event is folded into one already waiting for the same table and
-- event — `coalesce_key` — until a worker claims it.
--
-- Receipts leave it null and never fold: each one is its own announcement.
-- `batch` stays the primary key and becomes a generated `dlv_` id for events.

ALTER TABLE receipt_delivery_queue
  ADD COLUMN IF NOT EXISTS coalesce_key text;

CREATE INDEX IF NOT EXISTS receipt_delivery_queue_coalesce
  ON receipt_delivery_queue (coalesce_key)
  WHERE coalesce_key IS NOT NULL AND claimed_at IS NULL;
