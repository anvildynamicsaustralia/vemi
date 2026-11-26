-- VEMI-013 proof: the held drop of what the trim left behind. ANDY RUNS THIS, never a script.
--
-- It sits outside migrations/ so that no deploy applies it by accident. After the production
-- counts match the trim report, and after a fresh export is taken, move this file into
-- migrations/ as the next deploy's step. It drops exactly the items marked
-- "deprecated by 00NN, dropped in proof" and tenant.plan, and nothing else.
--
-- Order: indexes first, then the tables, then the note rows, then the columns. No column
-- below sits in an index, a trigger, a view or another column's CHECK, so DROP COLUMN works
-- in place and no table rebuild is needed.

DROP INDEX venture_link_pair;
DROP INDEX venture_link_by_owner;
DROP INDEX duty_by_venture;
DROP INDEX duty_by_owner;

DROP TABLE venture_link;
DROP TABLE duty;

-- Their text was copied into task.body and milestone notes by 0014 (trim_converted records it).
DELETE FROM note WHERE task_id IS NOT NULL OR milestone_id IS NOT NULL;

ALTER TABLE task DROP COLUMN parked_at;
ALTER TABLE task DROP COLUMN icon;
ALTER TABLE task DROP COLUMN size;

ALTER TABLE venture DROP COLUMN board_x;
ALTER TABLE venture DROP COLUMN board_y;
ALTER TABLE venture DROP COLUMN map_x;
ALTER TABLE venture DROP COLUMN map_y;
ALTER TABLE venture DROP COLUMN map_z;

ALTER TABLE project DROP COLUMN board_x;
ALTER TABLE project DROP COLUMN board_y;

ALTER TABLE tenant DROP COLUMN plan;
