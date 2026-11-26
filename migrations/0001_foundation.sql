-- VEMI-003 foundation. The whole model, empty.
--
-- Every table a person writes into carries `owner` and `archived_at`. Nothing a person
-- made is ever deleted: archiving stamps the row, and a row is visible only while it and
-- every container above it are unarchived.
--
-- Plain statements only, no triggers, so this file applies to any SQLite unchanged. The
-- rules that span rows (nesting depth, a milestone belonging to the task's project) are
-- enforced in the WHERE clause of the statement that writes the row, in `store.ts`.

CREATE TABLE venture (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  icon        TEXT,
  goal        TEXT,
  position    REAL NOT NULL DEFAULT 0,
  parent_id   TEXT REFERENCES venture (id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX venture_by_owner ON venture (owner, parent_id);

-- Undirected: the pair is stored in id order so (a, b) and (b, a) are one row.
CREATE TABLE venture_link (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  a_id        TEXT NOT NULL REFERENCES venture (id),
  b_id        TEXT NOT NULL REFERENCES venture (id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  CHECK (a_id < b_id)
);
CREATE UNIQUE INDEX venture_link_pair ON venture_link (owner, a_id, b_id) WHERE archived_at IS NULL;

CREATE TABLE state (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  venture_id  TEXT NOT NULL REFERENCES venture (id),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind        TEXT NOT NULL CHECK (kind IN ('not_started', 'underway', 'finished')),
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX state_by_venture ON state (venture_id);

CREATE TABLE project (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  venture_id  TEXT NOT NULL REFERENCES venture (id),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  icon        TEXT,
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX project_by_venture ON project (venture_id);

-- `aiming_on` is soft. It is stored and ordered by, and never compared with today.
CREATE TABLE milestone (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  project_id  TEXT NOT NULL REFERENCES project (id),
  state_id    TEXT REFERENCES state (id),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aiming_on   TEXT CHECK (aiming_on IS NULL OR aiming_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX milestone_by_project ON milestone (project_id);

-- A title and a venture. Everything else is optional, forever.
CREATE TABLE task (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL CHECK (owner <> ''),
  venture_id   TEXT NOT NULL REFERENCES venture (id),
  project_id   TEXT REFERENCES project (id),
  milestone_id TEXT REFERENCES milestone (id),
  state_id     TEXT REFERENCES state (id),
  title        TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body         TEXT,
  checklist    TEXT NOT NULL DEFAULT '[]',
  priority     TEXT CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low')),
  due_on       TEXT CHECK (due_on IS NULL OR due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  picked_on    TEXT CHECK (picked_on IS NULL OR picked_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  icon         TEXT,
  position     REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT,
  CHECK (milestone_id IS NULL OR project_id IS NOT NULL)
);
CREATE INDEX task_by_venture ON task (venture_id);
CREATE INDEX task_by_project ON task (project_id);
CREATE INDEX task_for_today ON task (owner, picked_on, due_on);

-- A property of a task, not a state. At most one active blocker per task.
CREATE TABLE blocker (
  id               TEXT PRIMARY KEY,
  owner            TEXT NOT NULL CHECK (owner <> ''),
  task_id          TEXT NOT NULL REFERENCES task (id),
  reason           TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  waits_on_task_id TEXT REFERENCES task (id),
  person           TEXT,
  since_on         TEXT CHECK (since_on IS NULL OR since_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  archived_at      TEXT,
  CHECK (waits_on_task_id IS NULL OR waits_on_task_id <> task_id)
);
CREATE UNIQUE INDEX blocker_active ON blocker (task_id) WHERE archived_at IS NULL;

-- Yours, recorded, with no state, no date and no completion.
CREATE TABLE duty (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  venture_id  TEXT NOT NULL REFERENCES venture (id),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX duty_by_venture ON duty (venture_id);

CREATE TABLE note (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL CHECK (owner <> ''),
  venture_id   TEXT REFERENCES venture (id),
  project_id   TEXT REFERENCES project (id),
  milestone_id TEXT REFERENCES milestone (id),
  task_id      TEXT REFERENCES task (id),
  body         TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT,
  CHECK ((venture_id IS NOT NULL) + (project_id IS NOT NULL) + (milestone_id IS NOT NULL) + (task_id IS NOT NULL) = 1)
);

CREATE TABLE link (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  task_id     TEXT NOT NULL REFERENCES task (id),
  url         TEXT NOT NULL CHECK (length(trim(url)) > 0),
  label       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX link_by_task ON link (task_id);

-- Identity. A credential is what a passkey leaves behind; a person made it, so it archives.
CREATE TABLE credential (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL CHECK (owner <> ''),
  public_key   TEXT NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  archived_at  TEXT
);

CREATE TABLE recovery_code (
  owner      TEXT PRIMARY KEY CHECK (owner <> ''),
  code_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The Worker's own bookkeeping. Single-use and short-lived, so these are deleted.
CREATE TABLE challenge (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL CHECK (owner <> ''),
  purpose    TEXT NOT NULL CHECK (purpose IN ('setup', 'add', 'recover', 'sign_in')),
  challenge  TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE backup_run (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL CHECK (owner <> ''),
  ran_at     TEXT NOT NULL,
  ok         INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail     TEXT NOT NULL
);
CREATE INDEX backup_run_latest ON backup_run (owner, ok, ran_at);
