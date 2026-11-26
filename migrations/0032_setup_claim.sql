-- VEMI-013 setup helper. A copy made by the setup page is claimed once, by the code the page
-- set as SETUP_CLAIM. One row, id 1, owned by the instance and never by a person, so an export
-- carries none of it. The token is kept only when the person chose to keep the copy updated,
-- and then sealed under a key made from SETUP_CLAIM and the copy's own address. Plain
-- statements only, no BEGIN or COMMIT.

CREATE TABLE setup_claim (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL DEFAULT 'instance',
  claimed_at TEXT NOT NULL,
  sealed_token TEXT,
  keep_updated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
