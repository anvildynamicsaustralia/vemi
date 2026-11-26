-- VEMI-011: a venture's lifecycle, as data.
--
-- A stage is a venture's own named point on its arc: Concept, Production, Launched, whatever
-- the person calls it. Like a state it belongs to one venture, carries a name, a place in a
-- list and one of a fixed set of kinds (here five), and the person can rename, reorder, add
-- and archive them.
--
-- A stage is not a status, and it is not work. Nothing is finished by reaching one, nothing
-- is counted by one and nothing is ever derived from one: a venture or project sits at a
-- stage because a person put it there, and the kind is read in exactly one place, when a
-- project moves to another venture and takes that venture's matching stage.
--
-- At risk is one bit, set by hand on a venture or a project. Nothing derives it and nothing
-- reads it except to show it.
--
-- Additive on the same terms as every migration before it. `venture.stage_id` carries no
-- REFERENCES clause: a stage belongs to a venture and a venture points at a stage, a cycle
-- that no single table order in a backup could restore with foreign keys on. The write in
-- `store.ts` keeps it true instead. `project.stage_id` has no such cycle and keeps its
-- reference. Plain statements only, no triggers, exactly as `0001_foundation.sql` set out.

CREATE TABLE stage (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL CHECK (owner <> ''),
  venture_id  TEXT NOT NULL REFERENCES venture (id),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind        TEXT NOT NULL CHECK (kind IN ('early', 'active', 'paused', 'shipped', 'stopped')),
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX stage_by_venture ON stage (venture_id);

ALTER TABLE venture ADD COLUMN stage_id TEXT;
ALTER TABLE project ADD COLUMN stage_id TEXT REFERENCES stage (id);
ALTER TABLE venture ADD COLUMN at_risk INTEGER NOT NULL DEFAULT 0 CHECK (at_risk IN (0, 1));
ALTER TABLE project ADD COLUMN at_risk INTEGER NOT NULL DEFAULT 0 CHECK (at_risk IN (0, 1));

-- The default ten for every venture already there, archived ones included.
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Concept', 'early', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Pre-Production', 'early', 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Production', 'active', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Alpha', 'active', 4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Beta', 'active', 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Certification', 'active', 6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Launched', 'shipped', 7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Live Ops', 'shipped', 8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'On Hold', 'paused', 9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at) SELECT lower(hex(randomblob(16))), v.owner, v.id, 'Cancelled', 'stopped', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM venture v;
