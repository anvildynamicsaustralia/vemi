-- VEMI-011: a decision and a risk, the two records of the ledger.
--
-- A decision is something a person settled; a risk is something a person is watching. Each is
-- a title, an optional body, one soft date and a place in a list, attached to exactly one of a
-- venture or a project. That is all either of them is.
--
-- Neither has a status, and neither will. A decision is not open or closed, and a risk is not
-- mitigated or accepted: a column that said so would make them work to be finished, and they
-- are not work. They are never a task, never on a board or in today, and never counted. The
-- date says when it was recorded and nothing reads it except to show it; order is the
-- person's own, by `position`, and never by date.
--
-- Additive on the same terms as every migration before it. No existing table changes, and a
-- venture or project that holds neither is every venture and project that exists today.
--
-- Both carry `owner` and `archived_at` because every table a person writes into carries both.
-- Plain statements only, no triggers, exactly as `0001_foundation.sql` set out.

CREATE TABLE decision (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  venture_id  TEXT REFERENCES venture (id),
  project_id  TEXT REFERENCES project (id),
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body        TEXT,
  decided_on  TEXT CHECK (decided_on IS NULL OR decided_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  CHECK ((venture_id IS NOT NULL) + (project_id IS NOT NULL) = 1)
);
CREATE INDEX decision_by_venture ON decision (venture_id);
CREATE INDEX decision_by_project ON decision (project_id);

CREATE TABLE risk (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  venture_id  TEXT REFERENCES venture (id),
  project_id  TEXT REFERENCES project (id),
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body        TEXT,
  raised_on   TEXT CHECK (raised_on IS NULL OR raised_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  CHECK ((venture_id IS NOT NULL) + (project_id IS NOT NULL) = 1)
);
CREATE INDEX risk_by_venture ON risk (venture_id);
CREATE INDEX risk_by_project ON risk (project_id);
