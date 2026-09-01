-- Tenants and their credentials.
--
-- `slug` is unique because it is addressable: it is the first segment of every
-- route on this service. `account_key.digest` is unique across the whole table
-- rather than per account, which is what makes authentication a single indexed
-- lookup instead of a scan — and means two accounts cannot share a key even in
-- principle.
--
-- Only the digest is stored. A minted key is returned once, in the response
-- that created it, and never again: a table of live credentials is a table
-- worth stealing, and this one is not.

CREATE TABLE IF NOT EXISTS account (
  id          text        PRIMARY KEY,
  slug        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL,
  version     integer     NOT NULL
);

CREATE INDEX IF NOT EXISTS account_slug ON account (slug);

CREATE TABLE IF NOT EXISTS account_key (
  id            text        PRIMARY KEY,
  account_id    text        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  digest        text        NOT NULL UNIQUE,
  prefix        text        NOT NULL,
  label         text        NOT NULL,
  created_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS account_key_account ON account_key (account_id);

-- Deliberately no index on revoked_at. Revoked keys are walked and rejected in
-- the aggregate rather than filtered out in SQL, so that "revoked" and "never
-- existed" take the same time to answer.
