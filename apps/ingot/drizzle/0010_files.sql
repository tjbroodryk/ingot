-- Documents, and the queue that turns them into rows.
--
-- `/file` takes a PDF, a deck or a spreadsheet and makes it two things a
-- memory already knows how to hold: chunks in `ingot_chunks`, and — when the
-- caller asks — typed rows in a table of their own. Neither of those needs a
-- table here, and that is the design rather than an omission: both are
-- ORDINARY tables in the caller's memory, so they get the overlay, the
-- embedding sweeper, the roll-up into Parquet, tombstones, `/query` over both
-- tiers and deletion with the memory, none of it written a second time. The
-- same argument `ingot_receipts` made, applied to a bigger payload.
--
-- What does need a table is the work in between, and it needs one for a reason
-- the other queues state more mildly. Parsing a two-hundred-page PDF is
-- seconds to minutes. `Dispatcher.send` opens a transaction around every
-- command and the pool holds ten connections, so a command that accepted bytes
-- and parsed them would hold a tenth of the pool for the length of a document
-- — and a handful of concurrent uploads would starve the requests this service
-- exists to answer while looking like a database problem.
--
-- So the shape is `overlay_receipt_queue`'s, for the fourth time and for the
-- same three reasons:
--
--   `claimed_at` is a lease, not a row lock, because the work does not happen
--   inside one transaction: claim, parse, write, with no connection held
--   across the middle. It expires so a worker that died mid-parse does not
--   strand the document.
--
--   `attempts` is incremented AT CLAIM. This queue is the one where that
--   matters most, because it is the only one that can be killed by its own
--   input rather than by somebody else's latency — a malformed PDF that takes
--   a decoder down with it never reaches a failure handler, so a counter
--   written there would never move and that document would be retried for
--   ever.
--
--   A row that runs out of attempts stays here with `last_error` on it, out of
--   the worker's way and in front of whoever goes looking.
--
-- THE BYTES ARE NOT IN THIS TABLE. They are in the object store beside the
-- Parquet, because a fifty-megabyte deck in a jsonb column is precisely the
-- failure INGOT_STORAGE refuses to boot without a decision about. `object_key`
-- is resolved when the upload is accepted and stored here, rather than rebuilt
-- from (account, ingot, file) at claim time — for the reason
-- `receipt_delivery_queue.target` is stored: a row should record where it
-- actually put something.
--
-- Keeping the object after the parse is deliberate too. Every chunking
-- decision is baked into rows at write time and rows are append-only, so
-- re-chunking a document later means reading it again — which is possible only
-- because the original is still there.

CREATE TABLE IF NOT EXISTS file_queue (
  -- Ours, minted at upload. One upload is one row, so a retried request that
  -- reuses the id collapses onto it rather than parsing the same bytes twice.
  file_id        text        PRIMARY KEY,
  ingot_id       text        NOT NULL,
  -- Where the bytes went. Built by `Keys.file` from ids this service
  -- generated, never from the filename — a caller-supplied name that reached a
  -- path would be a write anywhere the process can reach.
  object_key     text        NOT NULL,
  -- As uploaded. A label for a human and a column in `ingot_files`; it is
  -- never joined to a path.
  filename       text        NOT NULL,
  -- Agreed between what the caller declared and what the first bytes say.
  -- Neither alone is trusted: a declared type is a caller choosing a decoder,
  -- and a sniffed one cannot tell a .docx from a .pptx, since both are zips.
  media_type     text        NOT NULL,
  bytes          bigint      NOT NULL,
  -- Of the stored object. What makes "have I uploaded this already" a question
  -- with an answer, and what a re-parse checks it is reading the same document.
  sha256         text        NOT NULL,
  -- The caller's own handle — a job id, a ticket. Null when they gave none.
  external_id    text,
  -- A `FileExtraction`, or null for chunks alone. Kept whole rather than
  -- normalised into columns: it is a mapping the caller wrote, it is replayed
  -- verbatim by the worker, and this service never queries into it.
  extract        jsonb,
  -- The caller's chunking knobs. Null means the format's own defaults, which
  -- is the usual case — WHICH boundary a document is split on is decided by
  -- what it is, and only HOW MUCH is anybody else's business.
  chunk_tokens   integer,
  overlap_tokens integer,
  attempts       integer     NOT NULL DEFAULT 0,
  last_error     text,
  claimed_at     timestamptz,
  queued_at      timestamptz NOT NULL
);

-- Leading on `attempts` because every claim filters on it before ordering by
-- age: rows that have run out are dead weight a worker should never walk past,
-- and nothing bounds how many of them accumulate.
CREATE INDEX IF NOT EXISTS file_queue_age
  ON file_queue (attempts, claimed_at, queued_at);

-- Destroying a memory destroys its unparsed uploads with it. The objects go
-- the same way the Parquet does: `removePrefix` after the transaction commits.
CREATE INDEX IF NOT EXISTS file_queue_ingot
  ON file_queue (ingot_id);
