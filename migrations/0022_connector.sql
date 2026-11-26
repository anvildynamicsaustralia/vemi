-- VEMI-013 connector. A person lets their own Claude or ChatGPT in. A client is an app that
-- asked (named by the app, owned by nobody). A code is the short-lived one-time answer to an
-- Allow, kept as a hash. A grant is one person's Allow for one client: only the hashes of its
-- tokens are stored, the refresh token lives 30 days from the last rotation
-- (refresh_expires_at), and revoking sets revoked_at. A change is one thing a client did, with
-- the record's earlier values as JSON so the person can undo it. Plain statements only, no
-- BEGIN or COMMIT.

CREATE TABLE connector_client (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE connector_code (
  hash TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES account (id),
  client_id TEXT NOT NULL REFERENCES connector_client (id),
  challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX connector_code_owner ON connector_code (owner);
CREATE INDEX connector_code_expires ON connector_code (expires_at);

CREATE TABLE connector_grant (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES account (id),
  client_id TEXT NOT NULL REFERENCES connector_client (id),
  client_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX connector_grant_owner ON connector_grant (owner, revoked_at, created_at);

CREATE TABLE connector_change (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES account (id),
  grant_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  before TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT
);

CREATE INDEX connector_change_owner ON connector_change (owner, created_at);
