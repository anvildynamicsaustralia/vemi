-- VEMI-010 phase 4: accounts.
--
-- An account is a person's way in: an email address, and a password, a Google identity, or
-- both. Purely additive: no existing row is rewritten and no table is rebuilt. The passkey
-- tables (`credential`, `recovery_code`, `challenge`) are untouched and keep working until
-- the code that uses them is removed.
--
-- The account id is the owner key. It references `tenant`, so an account is a tenant that
-- can be reached by address, and every row a person made keeps pointing at the same
-- `owner` it always did. An account is the sign-in record, not something a person made, so
-- like `tenant` it has no `archived_at`; deleting an account is a later phase.
--
-- `email_token` holds the links sent by mail: an invitation, a confirmation, a reset. The
-- id is the SHA-256 of the token, so the table alone cannot sign anyone in. `throttle` is
-- one row per failed attempt, counted over a window. Both are short-lived bookkeeping.
-- Plain statements only, no triggers.

CREATE TABLE account (
  id                 TEXT PRIMARY KEY REFERENCES tenant (id) CHECK (id <> ''),
  email              TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND instr(email, '@') > 1),
  email_confirmed_at TEXT,
  password_hash      TEXT,
  google_sub         TEXT UNIQUE,
  session_generation INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL)
);

CREATE TABLE email_token (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL CHECK (owner <> ''),
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite', 'confirm', 'reset')),
  email      TEXT NOT NULL CHECK (email = lower(trim(email))),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX email_token_by_owner ON email_token (owner, purpose);

CREATE TABLE throttle (
  key TEXT NOT NULL,
  at  TEXT NOT NULL
);
CREATE INDEX throttle_by_key ON throttle (key, at);
