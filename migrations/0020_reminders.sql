-- VEMI-013 reminders. Phones are told about a task through the browser's own push service, so
-- the Worker keeps four things. push_subscription: one row per device that turned reminders
-- on, with the zone that device lives in (an unsubscribed device is archived, and turning it
-- on again clears that). reminder_sent: one row for each reminder already sent, so a minute
-- that runs twice sends once. vapid_key: the one key pair this copy signs with, made on first
-- use unless both keys are set as secrets. The owner column on vapid_key is always instance.
-- Four account columns hold what the person chose; every account starts with all of it off.
-- Plain statements only, no BEGIN or COMMIT.

CREATE TABLE push_subscription (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES account (id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT,
  tz TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  archived_at TEXT
);

CREATE INDEX push_subscription_owner ON push_subscription (owner);

CREATE TABLE reminder_sent (
  owner TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (owner, kind, ref, at)
);

CREATE TABLE vapid_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL DEFAULT 'instance',
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

ALTER TABLE account ADD COLUMN remind_morning TEXT;
ALTER TABLE account ADD COLUMN remind_tasks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account ADD COLUMN quiet_from TEXT;
ALTER TABLE account ADD COLUMN quiet_to TEXT;
