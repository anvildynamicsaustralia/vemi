-- VEMI-013 landing. One row for the whole copy: whether a signed-out visitor to the front
-- address sees the landing page (landing = 1, the default) or goes straight to the sign-in card.
-- No row means on. The owner of the copy changes it; archived_at is kept like every table's
-- and nothing is deleted. Plain statements only, no BEGIN or COMMIT.

CREATE TABLE front_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL DEFAULT 'instance',
  landing INTEGER NOT NULL DEFAULT 1 CHECK (landing IN (0, 1)),
  created_at TEXT NOT NULL,
  archived_at TEXT
);
