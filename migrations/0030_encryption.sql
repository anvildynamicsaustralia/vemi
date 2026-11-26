-- VEMI-013 full encryption. Where an account is in sealing its typed text.
-- encryption: off, turning_on, on or turning_off. The server holds envelopes only while on,
-- and the device that does the sealing says when it is done. Existing rows start off.
-- Plain statements only, no BEGIN or COMMIT.

ALTER TABLE account ADD COLUMN encryption TEXT NOT NULL DEFAULT 'off' CHECK (encryption IN ('off', 'turning_on', 'on', 'turning_off'));
