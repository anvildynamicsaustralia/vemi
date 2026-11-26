-- VEMI-013 search. A saved filter is a search a person wants to run again: a name and the
-- words typed. One row each, owned by one account and read only through that owner. Removing
-- one sets archived_at, so a saved search leaves the list but nothing is destroyed, and no
-- task or project is touched. Plain statements only, no BEGIN or COMMIT.

CREATE TABLE saved_filter (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX saved_filter_owner ON saved_filter (owner, archived_at, position);
