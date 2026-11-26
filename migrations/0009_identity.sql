-- VEMI-011: a description, a register of links, and a size.
--
-- A venture's `goal` and the one-liner a person wanted on a project were two names for one
-- sentence, and Andy chose one: `description`. The venture column is renamed in place and
-- its text is kept; a project gains the same column, empty until someone writes it.
--
-- A link can now sit on a venture or a project as well as a task, and it carries a role:
-- the repo, the docs, the site, or anything else. A role is a word for what the link points
-- at, never a status, and it is not unique per parent: a venture can have two repos. Every
-- link that exists today becomes `other`.
--
-- Size is how big, beside priority, which is which first. It sits on `task` only, it is
-- never required, and nothing computes from it.
--
-- The `link` rebuild is the one statement in this repo's history that removes a table, and
-- it does so only after every row has been copied. The old table is renamed out of the way
-- first, so the new one keeps its schema text exactly as written below; no table
-- references `link`, so the rename rewrites nobody's foreign key. The index names are taken
-- until the old table is gone, so they are created last.
--
-- Plain statements only, no triggers, exactly as `0001_foundation.sql` set out.

ALTER TABLE venture RENAME COLUMN goal TO description;

ALTER TABLE project ADD COLUMN description TEXT;

ALTER TABLE task ADD COLUMN size TEXT CHECK (size IS NULL OR size IN ('xs', 's', 'm', 'l', 'xl'));

ALTER TABLE link RENAME TO link_old;

CREATE TABLE link (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  venture_id  TEXT REFERENCES venture (id),
  project_id  TEXT REFERENCES project (id),
  task_id     TEXT REFERENCES task (id),
  url         TEXT NOT NULL CHECK (length(trim(url)) > 0),
  label       TEXT,
  role        TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('repo', 'docs', 'site', 'other')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  CHECK ((venture_id IS NOT NULL) + (project_id IS NOT NULL) + (task_id IS NOT NULL) = 1)
);

INSERT INTO link (id, owner, task_id, url, label, role, created_at, updated_at, archived_at)
SELECT id, owner, task_id, url, label, 'other', created_at, updated_at, archived_at FROM link_old;

DROP TABLE link_old;

CREATE INDEX link_by_task ON link (task_id);
CREATE INDEX link_by_venture ON link (venture_id);
CREATE INDEX link_by_project ON link (project_id);
