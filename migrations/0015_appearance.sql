-- VEMI-013 design. An account keeps three look settings: the accent, how much room rows
-- take, and which theme. The defaults are the shipped look, so an existing account changes
-- nothing until its owner picks. Plain statements only, no BEGIN or COMMIT.

ALTER TABLE account ADD COLUMN accent TEXT NOT NULL DEFAULT 'ember'
  CHECK (accent IN ('ember', 'ocean', 'moss', 'violet', 'rose', 'graphite'));
ALTER TABLE account ADD COLUMN spacing TEXT NOT NULL DEFAULT 'comfortable'
  CHECK (spacing IN ('comfortable', 'compact'));
ALTER TABLE account ADD COLUMN theme TEXT NOT NULL DEFAULT 'system'
  CHECK (theme IN ('light', 'dark', 'system'));
