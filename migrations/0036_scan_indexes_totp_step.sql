-- VEMI-013 hardening. HELD with the other held migrations: the owner runs it, and no tool does.
-- It is numbered 0036 because 0035 is kept for the held drop in scripts/data/held.
--
-- Additive and safe: two indexes and two nullable columns; no row is rewritten and no table is
-- rebuilt.
--
-- 1. `task_by_remind`: the reminder scan runs every minute and asks for one account's tasks with
--    a reminder between two local times. Without it that read walks all of the account's tasks.
--    Partial, because most tasks have no reminder.
-- 2. `throttle_by_at`: every sign-in attempt first sweeps rows older than the window. The sweep
--    is keyed on `at`, and `throttle_by_key` leads with the key, so the sweep
--    walked the whole table. This lets it read only the old rows.
-- 3. `account.totp_last_step`: the last 30 second time step of an authenticator code that signed
--    this account in. A code at or before it is refused, so a code seen over a shoulder or in a
--    log cannot be used again inside its 90 second window. Null until the first such sign-in.
--
-- 4. `update_offer.issued_at`: the newest signed issue date of any release the daily check has
--    read (the release manifest now carries one). A feed that serves an older date is refused, so a
--    replayed old feed cannot hide a newer release. Null until the first check after this.
--
-- Plain statements only, no BEGIN or COMMIT.

CREATE INDEX IF NOT EXISTS task_by_remind ON task (owner, remind_at) WHERE remind_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS throttle_by_at ON throttle (at);

ALTER TABLE account ADD COLUMN totp_last_step INTEGER;
ALTER TABLE update_offer ADD COLUMN issued_at TEXT;
