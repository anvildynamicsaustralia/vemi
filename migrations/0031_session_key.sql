-- VEMI-013 zero-secret start. A copy starts with no secret set: the key that signs a session cookie is
-- made on first use and kept here, as vapid_key keeps the push pair. One row, id 1, owned by the
-- instance and never by a person, so an export carries none of it. Setting SESSION_SECRET
-- replaces it. Plain statements only, no BEGIN or COMMIT.

CREATE TABLE session_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL DEFAULT 'instance',
  secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
