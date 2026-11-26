-- VEMI-013 today. A task may carry a reminder and a repeat, both optional and empty until
-- the person sets one. remind_at is a local wall time, YYYY-MM-DDTHH:MM, with no zone; the
-- reminders phase reads it in the account's zone. repeat is day, weekday, month or week:N
-- (N 1 to 7, Monday is 1); the grammar lives in packages/shared/src/repeat.ts and is checked
-- there and in validate.ts, so the column holds plain text. Plain statements only, no BEGIN
-- or COMMIT.

ALTER TABLE task ADD COLUMN remind_at TEXT;
ALTER TABLE task ADD COLUMN repeat TEXT;
