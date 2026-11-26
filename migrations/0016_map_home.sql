-- VEMI-013 map. The map home keeps three things: which way the account draws it (grid or
-- canvas), which projects are pinned, and where each box sits on the canvas. A position
-- belongs to the account and not to the record, so projects get one too. The defaults are
-- the shipped look, so an existing account changes nothing until its owner picks. Plain
-- statements only, no BEGIN or COMMIT.
--
-- venture.map_x, map_y and map_z (0004_map.sql): deprecated by 0016, dropped in proof.
-- Nothing reads them after this file; the copy below is the last use.

ALTER TABLE account ADD COLUMN map_style TEXT NOT NULL DEFAULT 'grid'
  CHECK (map_style IN ('grid', 'canvas'));

-- When the person pinned the project, or NULL. Set by hand; nothing derives it.
ALTER TABLE project ADD COLUMN pinned_at TEXT;

CREATE TABLE IF NOT EXISTS canvas_pos (
  owner TEXT NOT NULL CHECK (owner <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('venture', 'project')),
  id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (owner, kind, id)
);

-- Every venture position the old map kept: x and y set and no z, the rule `kept` uses.
INSERT OR IGNORE INTO canvas_pos (owner, kind, id, x, y)
  SELECT owner, 'venture', id, map_x, map_y FROM venture
  WHERE map_x IS NOT NULL AND map_y IS NOT NULL AND map_z IS NULL;
