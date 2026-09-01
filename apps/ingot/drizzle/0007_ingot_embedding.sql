-- The vector space a memory's embeddings live in.
--
-- Recorded on the memory rather than read from configuration at query time,
-- because a stored vector is only meaningful beside vectors from the same
-- model. `INGOT_EMBEDDER` is a property of the process; this is a property of
-- the data, and the two stop agreeing the moment somebody edits the first.
--
-- The failure this prevents has no error and no symptom. Cosine similarity
-- between vectors from two different models is a perfectly ordinary number
-- that means nothing at all — so a memory embedded with one model and then
-- queried through another returns confident, plausible, wrong rankings for as
-- long as nobody checks by hand. Claimed by the first embedding written, held
-- to from then on, and a mismatch is refused with the two model names in it.
--
-- Null for a memory that has never embedded anything, which is most of them:
-- `"embed": true` is opt-in per column. Both columns or neither — the
-- aggregate is what keeps them together, since a width without a model is not
-- a vector space.

ALTER TABLE ingot
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_dims  integer;
