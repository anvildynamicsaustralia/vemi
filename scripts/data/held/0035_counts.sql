-- VEMI-013 proof: the counts to read BEFORE the held drop (0035_drop_cut.sql).
-- Read only: every statement is a SELECT. The owner runs it against the production database and
-- keeps the answer next to the fresh export. Run once before the drop and once after the deploy
-- that carries the trim; the drop goes ahead only when what 0035 removes was already copied
-- (trim_converted) or is empty.
--
--   pnpm exec wrangler d1 execute DB --remote --config wrangler.andy.jsonc --file scripts/data/held/0035_counts.sql

SELECT 'venture_link rows' AS what, COUNT(*) AS n FROM venture_link
UNION ALL SELECT 'duty rows', COUNT(*) FROM duty
UNION ALL SELECT 'note rows on a task or milestone', COUNT(*) FROM note WHERE task_id IS NOT NULL OR milestone_id IS NOT NULL
UNION ALL SELECT 'tasks with parked_at, icon or size set', COUNT(*) FROM task WHERE parked_at IS NOT NULL OR icon IS NOT NULL OR size IS NOT NULL
UNION ALL SELECT 'ventures with a board or map position', COUNT(*) FROM venture WHERE board_x IS NOT NULL OR board_y IS NOT NULL OR map_x IS NOT NULL OR map_y IS NOT NULL OR map_z IS NOT NULL
UNION ALL SELECT 'projects with a board position', COUNT(*) FROM project WHERE board_x IS NOT NULL OR board_y IS NOT NULL
UNION ALL SELECT 'tenants', COUNT(*) FROM tenant;

-- What 0014 recorded as copied, to compare with the first four lines above.
SELECT * FROM trim_converted;
