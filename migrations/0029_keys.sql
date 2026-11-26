-- VEMI-013 crypto. A person's account key is made on a device and never leaves one unwrapped.
-- key_wrap keeps the copies of it that a way in can open (passkey, password, recovery) and one
-- device row for each device that holds the key; only ciphertext, a public key reference and a
-- public key check are stored. Removing a row sets archived_at; nothing is deleted. key_pairing
-- relays one sealed copy to a new device for ten minutes and is archived when the new device
-- reads it. Plain statements only, no BEGIN or COMMIT.

CREATE TABLE key_wrap (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES account (id),
  key_ref TEXT NOT NULL,
  key_check TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('passkey', 'password', 'recovery', 'device')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  device_id TEXT REFERENCES key_wrap (id),
  credential_id TEXT,
  salt TEXT,
  iterations INTEGER,
  wrapped TEXT CHECK (wrapped IS NULL OR length(wrapped) <= 512),
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX key_wrap_by_owner ON key_wrap (owner, archived_at);

CREATE TABLE key_pairing (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES account (id),
  public_part TEXT,
  sealed TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX key_pairing_by_owner ON key_pairing (owner, archived_at);
