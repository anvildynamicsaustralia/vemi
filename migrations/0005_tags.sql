-- VEMI-009: a tag, and the two edges that carry it.
--
-- The effort's one new object. A tag is a cross-cutting label — admin, legal, deep work —
-- and a task or a project can carry any number of them. It spans ventures rather than
-- sitting inside one, and it is never put on a venture itself: a venture already says what
-- it is with its name and its goal, and a label on top of that would be a second way of
-- saying the same thing.
--
-- There is no colour column here, and there will not be one. Colour in this application
-- carries state and nothing else; giving each label a colour of its own is how that
-- discipline dies on the first day. If two tags need telling apart, that is what the words
-- are for.
--
-- Additive on the same terms as every migration before it. Nothing already here changes
-- meaning: no column is added to `task` or `project`, and a row that carries no tag is a
-- row with no join rows, which is every row that exists today.
--
-- Assignment is two plain join tables rather than records of their own. They carry `owner`
-- and `archived_at` because every table a person writes into carries both, and this is one:
-- a person chose the tag and put it there. `archived_at` on a join row stays NULL, because
-- an assignment is archived by archiving one of its ends — the task, the project or the tag
-- — and never on its own.
--
-- The partial unique index on (owner, name) is what makes "chosen from what exists before a
-- new one is made" enforceable rather than hoped for: two live tags cannot share a name for
-- one owner, and an archived tag does not keep its name from being used again.
--
-- Plain statements only, no triggers, exactly as `0001_foundation.sql` set out.

CREATE TABLE tag (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX tag_by_name ON tag (owner, name) WHERE archived_at IS NULL;

CREATE TABLE task_tag (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  task_id     TEXT NOT NULL REFERENCES task (id),
  tag_id      TEXT NOT NULL REFERENCES tag (id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX task_tag_once ON task_tag (task_id, tag_id);
CREATE INDEX task_tag_by_tag ON task_tag (tag_id);

CREATE TABLE project_tag (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  project_id  TEXT NOT NULL REFERENCES project (id),
  tag_id      TEXT NOT NULL REFERENCES tag (id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX project_tag_once ON project_tag (project_id, tag_id);
CREATE INDEX project_tag_by_tag ON project_tag (tag_id);
