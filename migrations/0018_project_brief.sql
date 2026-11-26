-- VEMI-013 project. A project's brief has four steps: what it is (description, already
-- there), who it is for, what done looks like, and the open questions. The three new columns
-- are free text, all empty until the person writes one; the length limit lives in
-- validate.ts. Plain statements only, no BEGIN or COMMIT.

ALTER TABLE project ADD COLUMN who_for TEXT;
ALTER TABLE project ADD COLUMN done_looks TEXT;
ALTER TABLE project ADD COLUMN open_questions TEXT;
