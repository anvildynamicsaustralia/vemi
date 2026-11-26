-- VEMI-004 decisions 23 and 24.
--
-- Where a venture or a project sits on the board, and the order of the picked list on
-- today. Additive and nullable on purpose: a row that has never been moved has no
-- coordinates, and the board lays it out until it is moved for the first time. Nothing
-- that was already here changes meaning — `position` still orders a board column, and
-- membership, ownership and blocked-by still need no new storage.
--
-- Parking does not appear here and had no storage anywhere when this was written:
-- `shelved` is a colour, not a state kind. Decision 25 settled it; see `0003_parked.sql`.

ALTER TABLE venture ADD COLUMN board_x REAL;
ALTER TABLE venture ADD COLUMN board_y REAL;

ALTER TABLE project ADD COLUMN board_x REAL;
ALTER TABLE project ADD COLUMN board_y REAL;

-- `position` is the board column's order and the picked list crosses columns, so today
-- needs a number of its own. Null until the list is first reordered by hand.
ALTER TABLE task ADD COLUMN today_position REAL;
