-- VEMI-013 self-update. Two rows at most, both owned by the instance and never by a person, so
-- an export carries neither. update_offer is the last daily check: when it ran, and the signed
-- release it found when that release is newer than the running copy. update_run is the one
-- update in progress or just done, step by step. Plain statements only, no BEGIN or COMMIT.

CREATE TABLE update_offer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL DEFAULT 'instance',
  version TEXT,
  manifest TEXT,
  signature TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE update_run (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL DEFAULT 'instance',
  version TEXT NOT NULL,
  step TEXT NOT NULL,
  state TEXT NOT NULL,
  account_id TEXT,
  database_id TEXT,
  worker_name TEXT,
  previous_version_id TEXT,
  new_version_id TEXT,
  bookmark TEXT,
  migrated INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  back_until TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
