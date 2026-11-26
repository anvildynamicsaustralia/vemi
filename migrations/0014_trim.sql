-- VEMI-013 trim. The cut features stop appearing on screens; the data they held moves
-- somewhere a person can still read it. Nothing is deleted. A source row is never removed
-- and never edited, except a parked task, which moves to a state and stops being parked.
--
-- Every conversion is recorded in `trim_converted`, and every statement below skips a
-- source row already recorded there, so the whole file can run again and change nothing.
-- A conversion writes its target first and records its source second, so the "not yet
-- converted" test is still true while the target is written.
--
-- Plain statements only, no BEGIN or COMMIT: D1 wraps a migration itself.

CREATE TABLE IF NOT EXISTS trim_converted (
  kind      TEXT NOT NULL,
  id        TEXT NOT NULL,
  target_id TEXT,
  at        TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

-- Parked tasks: the first not_started state of the task's space, lowest position. A space
-- with no such state leaves the task's state as it was.
INSERT INTO trim_converted (kind, id, target_id, at)
SELECT 'parked-task', t.id,
  (SELECT s.id FROM state s
    WHERE s.venture_id = t.venture_id AND s.kind = 'not_started' AND s.archived_at IS NULL
    ORDER BY s.position, s.id LIMIT 1),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM task t
WHERE t.parked_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'parked-task' AND c.id = t.id);

UPDATE task
SET state_id = COALESCE((SELECT c.target_id FROM trim_converted c WHERE c.kind = 'parked-task' AND c.id = task.id), state_id),
    parked_at = NULL
WHERE parked_at IS NOT NULL;

-- Task notes: appended to the body under a line `Notes:`, oldest first, one per paragraph.
UPDATE task
SET body = CASE WHEN body IS NULL OR body = '' THEN '' ELSE body || char(10) || char(10) END
    || 'Notes:' || char(10)
    || (SELECT group_concat(pick.body, char(10) || char(10)) FROM (
          SELECT n.body AS body FROM note n
          WHERE n.task_id = task.id AND n.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'task-note' AND c.id = n.id)
          ORDER BY n.created_at, n.id) pick)
WHERE EXISTS (
  SELECT 1 FROM note n
  WHERE n.task_id = task.id AND n.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'task-note' AND c.id = n.id));

INSERT INTO trim_converted (kind, id, target_id, at)
SELECT 'task-note', n.id, n.task_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM note n
WHERE n.task_id IS NOT NULL AND n.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'task-note' AND c.id = n.id);

-- Milestone notes: one new project note per milestone. Its id is `trim-` and the id of the
-- newest note it holds, so a later batch of notes on the same milestone gets its own.
INSERT INTO note (id, owner, project_id, body, created_at, updated_at)
SELECT
  'trim-' || (SELECT n.id FROM note n
              WHERE n.milestone_id = m.id AND n.archived_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'milestone-note' AND c.id = n.id)
              ORDER BY n.created_at DESC, n.id DESC LIMIT 1),
  m.owner, m.project_id,
  m.name || char(10) || (SELECT group_concat(pick.body, char(10) || char(10)) FROM (
      SELECT n.body AS body FROM note n
      WHERE n.milestone_id = m.id AND n.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'milestone-note' AND c.id = n.id)
      ORDER BY n.created_at, n.id) pick),
  (SELECT n.created_at FROM note n
   WHERE n.milestone_id = m.id AND n.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'milestone-note' AND c.id = n.id)
   ORDER BY n.created_at DESC, n.id DESC LIMIT 1),
  (SELECT n.created_at FROM note n
   WHERE n.milestone_id = m.id AND n.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'milestone-note' AND c.id = n.id)
   ORDER BY n.created_at DESC, n.id DESC LIMIT 1)
FROM milestone m
WHERE EXISTS (
  SELECT 1 FROM note n
  WHERE n.milestone_id = m.id AND n.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'milestone-note' AND c.id = n.id));

INSERT INTO trim_converted (kind, id, target_id, at)
SELECT 'milestone-note', n.id,
  'trim-' || (SELECT n2.id FROM note n2
              WHERE n2.milestone_id = n.milestone_id AND n2.archived_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'milestone-note' AND c.id = n2.id)
              ORDER BY n2.created_at DESC, n2.id DESC LIMIT 1),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM note n
WHERE n.milestone_id IS NOT NULL AND n.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'milestone-note' AND c.id = n.id);

-- Duties: appended to the space's description under a line `Duties:`, one line each, in
-- position order, `name: description` when the duty has a description.
UPDATE venture
SET description = CASE WHEN description IS NULL OR description = '' THEN '' ELSE description || char(10) || char(10) END
    || 'Duties:' || char(10)
    || (SELECT group_concat(pick.line, char(10)) FROM (
          SELECT CASE WHEN d.description IS NOT NULL AND trim(d.description) <> ''
                      THEN d.name || ': ' || d.description ELSE d.name END AS line
          FROM duty d
          WHERE d.venture_id = venture.id AND d.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'duty' AND c.id = d.id)
          ORDER BY d.position, d.created_at, d.id) pick)
WHERE EXISTS (
  SELECT 1 FROM duty d
  WHERE d.venture_id = venture.id AND d.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'duty' AND c.id = d.id));

INSERT INTO trim_converted (kind, id, target_id, at)
SELECT 'duty', d.id, d.venture_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM duty d
WHERE d.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM trim_converted c WHERE c.kind = 'duty' AND c.id = d.id);

-- Left in place, no longer shown, counted by the trim report. Nothing below changes.
-- deprecated by 0014, dropped in proof: task.parked_at (now always null)
-- deprecated by 0014, dropped in proof: note rows with task_id or milestone_id set
-- deprecated by 0014, dropped in proof: table duty
-- deprecated by 0014, dropped in proof: table venture_link
-- deprecated by 0014, dropped in proof: task.icon
-- deprecated by 0014, dropped in proof: task.size
-- deprecated by 0014, dropped in proof: venture.board_x, venture.board_y
-- deprecated by 0014, dropped in proof: project.board_x, project.board_y
