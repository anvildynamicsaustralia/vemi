-- VEMI-013 capture. An account keeps two more settings: the space new tasks go to (empty
-- means the space used last) and the date of its last weekly review. Both start empty, so an
-- existing account changes nothing until its owner chooses. If the chosen space is ever
-- deleted the setting goes back to empty. Plain statements only, no BEGIN or COMMIT.

ALTER TABLE account ADD COLUMN new_task_venture_id TEXT REFERENCES venture (id) ON DELETE SET NULL;
ALTER TABLE account ADD COLUMN last_review_on TEXT;
