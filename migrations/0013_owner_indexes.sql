-- VEMI-010: every tenant table is read by owner through an index.
--
-- Since accounts, every person's rows share one table per kind, and the tree, every list,
-- the archive and search read a table by `owner` first. Most tables were indexed only by
-- their parent (`venture_id`, `project_id`, `task_id`), so each of those reads walked every
-- account's rows to find one person's. `(owner, archived_at)` serves both halves: the live
-- views ask for `archived_at IS NULL` and the archive for `IS NOT NULL`.
--
-- Purely additive: indexes only, no row is written and no table is rebuilt. `venture`
-- already has `venture_by_owner`. `tag` and `venture_link` have owner-led indexes, but only
-- partial ones over unarchived rows, which the archive cannot use. `ownerIndexes.test.ts`
-- reads SQLite's plan for every statement those reads send and fails on a walk of a table.

CREATE INDEX IF NOT EXISTS venture_link_by_owner ON venture_link (owner, archived_at);
CREATE INDEX IF NOT EXISTS state_by_owner ON state (owner, archived_at);
CREATE INDEX IF NOT EXISTS stage_by_owner ON stage (owner, archived_at);
CREATE INDEX IF NOT EXISTS project_by_owner ON project (owner, archived_at);
CREATE INDEX IF NOT EXISTS milestone_by_owner ON milestone (owner, archived_at);
CREATE INDEX IF NOT EXISTS task_by_owner ON task (owner, archived_at);
CREATE INDEX IF NOT EXISTS blocker_by_owner ON blocker (owner, archived_at);
CREATE INDEX IF NOT EXISTS duty_by_owner ON duty (owner, archived_at);
CREATE INDEX IF NOT EXISTS note_by_owner ON note (owner, archived_at);
CREATE INDEX IF NOT EXISTS decision_by_owner ON decision (owner, archived_at);
CREATE INDEX IF NOT EXISTS risk_by_owner ON risk (owner, archived_at);
CREATE INDEX IF NOT EXISTS link_by_owner ON link (owner, archived_at);
CREATE INDEX IF NOT EXISTS tag_by_owner ON tag (owner, archived_at);
