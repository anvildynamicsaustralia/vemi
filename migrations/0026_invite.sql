-- VEMI-013 people. The owner of a copy invites a person by first name and passes on a link. An
-- invite is kept as the SHA-256 of its token, good for one use and seven days. Using it sets
-- used_at and names the account it made (accepted_by); withdrawing it sets archived_at. Nothing
-- is deleted. account.first_name is what the person was invited as. Plain statements only, no
-- BEGIN or COMMIT.

CREATE TABLE invite (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES account (id),
  first_name TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 60),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  accepted_by TEXT,
  archived_at TEXT
);

CREATE INDEX invite_by_owner ON invite (owner, created_at);

ALTER TABLE account ADD COLUMN first_name TEXT;
