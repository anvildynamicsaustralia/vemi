-- VEMI-011: a project can sit inside another project, one level deep.
--
-- A project already sits inside a venture. This lets a larger piece of work be broken into
-- a few smaller ones that still read as one thing: the pieces are projects, and the larger
-- one is a project that holds them. It is the same bargain ventures made with
-- `venture.parent_id`, on the same terms (decisions.md, "7, nest").
--
-- One level, and it is enforced in `store.ts`, not here. A CHECK cannot see another row, and
-- this file keeps to the rule `0001_foundation.sql` set out: plain statements, no triggers,
-- every rule that reads a second row in the WHERE clause of the write that would break it.
-- The only thing the column can say for itself is that a project is not its own parent.
--
-- Purely additive. The column is nullable and nothing is written to it, so every project
-- that exists is top-level, and every query that ignores it reads what it read before.
-- No new table, and no other column.

ALTER TABLE project ADD COLUMN parent_id TEXT REFERENCES project (id) CHECK (parent_id IS NULL OR parent_id <> id);

CREATE INDEX project_by_parent ON project (parent_id);
