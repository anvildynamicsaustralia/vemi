-- VEMI-013 first-run. Where an account is in the first steps, and which tips it has been shown.
-- first_run_step: 1 to 7 while the steps are on; null is finished or never started.
-- tips_seen: a JSON list of tip names already shown; null means no tips to show.
-- Existing rows are left alone, so an account made before this sees neither. New accounts
-- are given step 1 and an empty list by the inserts in the store. Plain statements only,
-- no BEGIN or COMMIT.

ALTER TABLE account ADD COLUMN first_run_step INTEGER;
ALTER TABLE account ADD COLUMN tips_seen TEXT;
