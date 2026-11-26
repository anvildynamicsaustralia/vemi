-- VEMI-013 self-update. Go back names the release it returns to in words, so the run keeps the
-- version the copy ran before it, beside Cloudflare's own id for that version. Plain statements
-- only, no BEGIN or COMMIT.

ALTER TABLE update_run ADD COLUMN previous_version TEXT;
