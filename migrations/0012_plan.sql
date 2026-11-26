-- VEMI-010: every tenant carries a plan, and for now every plan is unlimited.
--
-- A plan says how much of the tool a tenant may use. There are two, `free` and `unlimited`,
-- and the column refuses any other word, so a typo cannot quietly invent a third.
--
-- Purely additive. One column, on `tenant`, and nothing else. The default is why nobody is
-- limited yet: every tenant that exists, and every tenant made before the limit is built,
-- reads `unlimited`. The limit phase turns `free` on by writing it, in `createAccount` and in
-- its own plan writer. It never changes this default, because changing a default does not
-- touch the rows already there and would make the column say two different things.

ALTER TABLE tenant ADD COLUMN plan TEXT NOT NULL DEFAULT 'unlimited' CHECK (plan IN ('free', 'unlimited'));
