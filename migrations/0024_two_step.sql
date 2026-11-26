-- VEMI-013 account. Two-step sign-in, kept on the account row. `two_step_secret` is the
-- authenticator's key, sealed with AES-GCM under a key derived from SESSION_SECRET (it cannot be
-- hashed, because the Worker has to compute codes from it); it is set while a person is setting
-- up and `two_step_on_at` stays empty until they have typed a first good code. `backup_codes` is
-- a JSON list of SHA-256 hashes of the ten codes shown once; each is removed as it is used.
-- Nothing changes for an account until its owner turns this on. The sign-in recovery code
-- lives in the `recovery_code` table from 0001. Plain statements only, no BEGIN or COMMIT.

ALTER TABLE account ADD COLUMN two_step_secret TEXT;
ALTER TABLE account ADD COLUMN two_step_on_at TEXT;
ALTER TABLE account ADD COLUMN backup_codes TEXT NOT NULL DEFAULT '[]';
