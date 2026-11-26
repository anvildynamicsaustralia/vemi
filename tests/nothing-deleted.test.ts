import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, isTestCode, walk } from "./walk.js";

/**
 * Deleting lives in one place.
 *
 * The foundation brief said archive and never delete. VEMI-004's decision 33 changed that:
 * delete exists, reached only through the archive, on something already archived. What has
 * not changed is that destroying a row is rare, deliberate and confined — so every
 * `DELETE FROM` stays inside `store.ts`, where `deletePreview` and `remove` are, rather than
 * appearing in a route, a component or a migration.
 *
 * `challenge` is exempt anywhere: a WebAuthn challenge is single-use, lives five minutes and
 * is the Worker's bookkeeping, not anything a person made.
 */

const DELETES_ALLOWED = "src/api/store.ts";

/**
 * A table rebuild with live data, proven by the migration test: SQLite cannot give a column
 * a second parent in place, so the old table is renamed, copied from and then removed. The
 * one statement that removes it is named exactly, in the one file that holds it. Cut out of
 * that file's text before the check below, it leaves anything else in the file, and any such
 * statement in any other file, still failing.
 *
 * `scripts/data/held/0035_drop_cut.sql` drops tables and deletes converted note rows. It is
 * outside `migrations/` and `src`, which this test walks, and it is the Andy-run step: it is
 * moved into `migrations/` only after the production counts match the trim report. It runs
 * under `src/api/dropCut.test.ts`.
 */
const REBUILDS = [
  { file: "migrations/0009_identity.sql", statement: "DROP TABLE link_old;" },
] as const;

describe("deleting lives in one place", () => {
  const files = [...walk("migrations", [".sql"]), ...walk("src", [".ts"])].filter((f) => !isTestCode(f));

  it("has no delete statement outside the store, except against challenges", () => {
    const hits: string[] = [];
    for (const file of files) {
      const raw = readFileSync(join(ROOT, file), "utf8");
      const rebuild = REBUILDS.find((r) => r.file === file.replaceAll("\\", "/"));
      const text = rebuild === undefined ? raw : raw.replace(rebuild.statement, "");
      for (const match of text.matchAll(/\bDELETE\s+FROM\s+[`"]?(\w+)/gi)) {
        if (match[1]?.toLowerCase() === "challenge") continue;
        if (file.replaceAll("\\", "/") === DELETES_ALLOWED) continue;
        hits.push(`${file} -> ${match[0]}`);
      }
      // Banned everywhere, the store included: a cascade is written out statement by
      // statement, in an order this codebase can read, never handed to the database.
      if (/\b(DROP\s+TABLE|TRUNCATE|ON\s+DELETE\s+CASCADE)\b/i.test(text)) hits.push(`${file} -> destructive DDL`);
    }
    expect(hits).toEqual([]);
  });

  it("removes a table only in a rebuild, and only after every row was copied", () => {
    for (const { file, statement } of REBUILDS) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const copy = text.search(/INSERT INTO link \([^)]*\)\s+SELECT[\s\S]*?FROM link_old/);
      const removal = text.indexOf(statement);
      expect(copy, "the copy is in the file").toBeGreaterThan(-1);
      expect(removal, "the removal is in the file").toBeGreaterThan(copy);
      expect(text.split(statement).length - 1, "the removal appears once").toBe(1);
    }
  });

  it("keeps the two methods that delete, so the rule above has something to point at", () => {
    const store = readFileSync(join(ROOT, DELETES_ALLOWED), "utf8");
    expect(store).toMatch(/async deletePreview\(/);
    expect(store).toMatch(/async remove\(/);
    // Decision 33: only something already archived, and only with its own name typed.
    expect(store).toContain("Archive it first. Only something already archived can be deleted.");
  });

  it("gives every table a person writes into an archived_at column", () => {
    const schema = walk("migrations", [".sql"]).map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
    const tables = [...schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)];
    // `account` is the sign-in record, and its id is the owner: it is not something a person
    // writes into, and deleting an account is a later phase. `email_token` and `throttle`
    // are short-lived and swept on write. The connector tables are the same kind of thing: a
    // client is an app's own name with no owner, a code is spent on use, and a grant or a
    // change is marked `revoked_at` or `undone_at` rather than archived.
    const bookkeeping = new Set([
      "challenge", "recovery_code", "backup_run", "tenant", "account", "email_token", "throttle",
      "connector_client", "connector_code", "connector_grant", "connector_change",
    ]);
    expect(tables.length).toBeGreaterThan(10);
    for (const [, name, body] of tables) {
      if (bookkeeping.has(name ?? "")) continue;
      expect(body, `${name} has archived_at`).toMatch(/\barchived_at\b/);
      expect(body, `${name} has owner`).toMatch(/\bowner\b/);
    }
  });
});
