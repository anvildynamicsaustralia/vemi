-- VEMI-013 account. What a person chose for their whole copy, kept on the account row: what the
-- four levels are called (empty means the shipped word), the stages a new space starts with
-- (a JSON list of name and kind, empty means Idea, Building, Live, Paused, Stopped), which
-- screen opens first, which Extras are on (a JSON object, a switch not named is on) and the
-- time zone the person lives in (empty means the Worker's own). A space gets two columns: which
-- views are on (a JSON list of board and projects) and the letters its plate shows (empty means
-- letters from its name). Every account and space starts as the shipped look, so nothing
-- changes until its owner picks. Plain statements only, no BEGIN or COMMIT.

ALTER TABLE account ADD COLUMN level_space TEXT;
ALTER TABLE account ADD COLUMN level_project TEXT;
ALTER TABLE account ADD COLUMN level_milestone TEXT;
ALTER TABLE account ADD COLUMN level_task TEXT;
ALTER TABLE account ADD COLUMN default_stages TEXT;
ALTER TABLE account ADD COLUMN start_on TEXT NOT NULL DEFAULT 'map'
  CHECK (start_on IN ('map', 'today'));
ALTER TABLE account ADD COLUMN extras TEXT NOT NULL DEFAULT '{}';
ALTER TABLE account ADD COLUMN time_zone TEXT;

ALTER TABLE venture ADD COLUMN views TEXT NOT NULL DEFAULT '["board","projects"]';
ALTER TABLE venture ADD COLUMN monogram TEXT;
