-- VEMI-010 phase 3: tenancy.
--
-- A tenant is an owner allowed to sign in. Purely additive: no existing row is rewritten
-- and no table is rebuilt. Backfilled from the owners that already exist, so Andy's data
-- becomes tenant one for free — `owner = 'andy'` on every row already made him one.

CREATE TABLE tenant (
  id         TEXT PRIMARY KEY CHECK (id <> ''),
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO tenant (id, created_at)
  SELECT owner, MIN(created_at) FROM (
    SELECT owner, created_at FROM venture UNION ALL
    SELECT owner, created_at FROM credential
  ) GROUP BY owner;
