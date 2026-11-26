-- VEMI-004 decision 11 and 25: a task can be parked.
--
-- Parking had no storage at all. `shelved` in the theme is a colour ("Also parked, and
-- also a machine that is asleep") and `STATE_KINDS` is not_started, underway and finished,
-- so nothing recorded a parked task. Decision 11 asks for one, so here it is.
--
-- Null means not parked. A parked task drops out of every board, the today list and every
-- outstanding count, exactly as a duty already does — but it is still on the board, so it
-- can be seen and taken back. Nothing a person made is deleted.

ALTER TABLE task ADD COLUMN parked_at TEXT;
