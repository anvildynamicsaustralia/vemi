import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_ROOT, migrationStatements, testDb, type TestDb } from "./testing/d1.js";

/**
 * 0009_identity run against rows in the old shape: every earlier migration applied, then a
 * fixture written with raw inserts for two owners, then the rest. Each assertion below is
 * there to fail when the matching line of the migration is broken.
 */

type Row = Record<string, unknown>;

const AT = "2020-01-01T00:00:00.000Z";
const LATER = "2021-02-03T04:05:06.000Z";
const LINK_COLUMNS = ["id", "owner", "task_id", "url", "label", "created_at", "updated_at", "archived_at"] as const;

let persist: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let db: D1Database;
let before: { counts: Record<string, number>; links: Row[]; ventures: Row[] };
let after: { counts: Record<string, number>; links: Row[]; ventures: Row[] };

async function userTables(): Promise<string[]> {
  const r = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
  ).all<{ name: string }>();
  return r.results.map((t) => t.name);
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of await userTables()) {
    const row = await db.prepare(`SELECT count(*) AS n FROM "${name}"`).first<{ n: number }>();
    out[name] = row?.n ?? 0;
  }
  return out;
}

const linkRows = async (): Promise<Row[]> =>
  (await db.prepare(`SELECT * FROM link ORDER BY id`).all<Row>()).results;

const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run();

beforeAll(async () => {
  persist = mkdtempSync(join(tmpdir(), "vemi-d1-"));
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(API_ROOT, "wrangler.jsonc"),
    persist: { path: persist },
    remoteBindings: false,
  });
  db = proxy.env.DB;

  // Through 0010: later migrations have tests of their own.
  const statements = migrationStatements((f) => f <= "0010_nest.sql");
  const cut = statements.findIndex((s) => /RENAME COLUMN goal TO description/i.test(s));
  expect(cut).toBeGreaterThan(-1);
  for (const sql of statements.slice(0, cut)) await db.prepare(sql).run();

  // The old shape, for two owners.
  const ventures: [string, string, string, string | null, string | null][] = [
    ["v-a1", "owner-a", "Alpha", "Ship the thing", null],
    ["v-a2", "owner-a", "Beta", null, null],
    ["v-b1", "owner-b", "Gamma", "It's the; goal", LATER],
  ];
  for (const [id, owner, name, goal, archived] of ventures) {
    await run(
      `INSERT INTO venture (id, owner, name, goal, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, owner, name, goal, AT, AT, archived,
    );
  }
  await run(
    `INSERT INTO project (id, owner, venture_id, name, created_at, updated_at) VALUES ('p-a1', 'owner-a', 'v-a1', 'Slice', ?, ?)`,
    AT, AT,
  );
  const tasks: [string, string, string][] = [["t-a1", "owner-a", "v-a1"], ["t-a2", "owner-a", "v-a2"], ["t-b1", "owner-b", "v-b1"]];
  for (const [id, owner, venture] of tasks) {
    await run(
      `INSERT INTO task (id, owner, venture_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, owner, venture, id, AT, AT,
    );
  }
  const links: [string, string, string, string, string | null, string | null][] = [
    ["l-1", "owner-a", "t-a1", "https://example.com/one", null, null],
    ["l-2", "owner-a", "t-a1", "https://example.com/two", "Docs", LATER],
    ["l-3", "owner-a", "t-a2", "https://example.com/?a='1';b=2", "Odd one", null],
    ["l-4", "owner-b", "t-b1", "https://example.org/four", "Four", null],
    ["l-5", "owner-b", "t-b1", "https://example.org/five", null, LATER],
  ];
  for (const [id, owner, task, url, label, archived] of links) {
    await run(
      `INSERT INTO link (id, owner, task_id, url, label, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, owner, task, url, label, AT, LATER, archived,
    );
  }

  before = {
    counts: await counts(),
    links: await linkRows(),
    ventures: (await db.prepare(`SELECT id, goal FROM venture ORDER BY id`).all<Row>()).results,
  };
  expect(before.counts.link).toBe(5);
  expect(before.links).toHaveLength(5);

  for (const sql of statements.slice(cut)) await db.prepare(sql).run();

  after = {
    counts: await counts(),
    links: await linkRows(),
    ventures: (await db.prepare(`SELECT id, description FROM venture ORDER BY id`).all<Row>()).results,
  };
});

afterAll(async () => {
  await proxy.dispose();
  rmSync(persist, { recursive: true, force: true });
});

describe("0009_identity over existing rows", () => {
  it("keeps every link row, with every old column identical", () => {
    expect(after.counts.link).toBe(before.counts.link);
    expect(after.links).toHaveLength(5);
    for (const [n, row] of after.links.entries()) {
      const old = before.links[n] as Row;
      for (const column of LINK_COLUMNS) expect(row[column], `${String(old.id)} ${column}`).toEqual(old[column]);
      expect(row.venture_id).toBeNull();
      expect(row.project_id).toBeNull();
      expect(row.role).toBe("other");
    }
  });

  it("keeps the count of every other table", () => {
    expect(after.counts).toEqual(before.counts);
  });

  it("renames goal to description in place, nulls included, and adds the empty columns", async () => {
    expect(after.ventures.map((v) => ({ id: v.id, description: v.description })))
      .toEqual(before.ventures.map((v) => ({ id: v.id, description: v.goal })));
    expect(after.ventures.some((v) => v.description === null)).toBe(true);
    expect(after.ventures.some((v) => v.description !== null)).toBe(true);
    const cols = (await db.prepare(`SELECT name FROM pragma_table_info('venture')`).all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).not.toContain("goal");
    const projects = (await db.prepare(`SELECT description FROM project`).all<Row>()).results;
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) expect(p.description).toBeNull();
    const tasks = (await db.prepare(`SELECT size FROM task`).all<Row>()).results;
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.size).toBeNull();
  });
});

describe("0009_identity schema", () => {
  it("keeps the link table's own text, plain and unquoted", async () => {
    const row = await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'link'`).first<{ sql: string }>();
    expect(row?.sql.startsWith("CREATE TABLE link (")).toBe(true);
  });

  it("leaves no link_old behind", async () => {
    expect(await userTables()).not.toContain("link_old");
  });

  it("recreates the three indexes on link", async () => {
    const rows = (await db.prepare(
      `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name IN ('link_by_task', 'link_by_venture', 'link_by_project') ORDER BY name`,
    ).all<{ name: string; tbl_name: string }>()).results;
    expect(rows).toEqual([
      { name: "link_by_project", tbl_name: "link" },
      { name: "link_by_task", tbl_name: "link" },
      { name: "link_by_venture", tbl_name: "link" },
    ]);
  });

  it("leaves no link pointing at a missing task", async () => {
    const orphans = await db.prepare(
      `SELECT l.id FROM link l LEFT JOIN task t ON t.id = l.task_id WHERE l.task_id IS NOT NULL AND t.id IS NULL`,
    ).all();
    expect(orphans.results).toEqual([]);
    const check = await db.prepare(`PRAGMA foreign_key_check`).all();
    expect(check.results).toEqual([]);
  });
});

describe("0009_identity constraints", () => {
  const insert = (id: string, parents: { venture?: string; project?: string; task?: string }, role = "repo") =>
    run(
      `INSERT INTO link (id, owner, venture_id, project_id, task_id, url, role, created_at, updated_at) VALUES (?, 'owner-a', ?, ?, ?, 'https://example.com', ?, ?, ?)`,
      id, parents.venture ?? null, parents.project ?? null, parents.task ?? null, role, AT, AT,
    );

  it("accepts a link on a venture, a project, or a task", async () => {
    await insert("ok-v", { venture: "v-a1" });
    await insert("ok-p", { project: "p-a1" });
    await insert("ok-t", { task: "t-a1" });
  });

  it("refuses two parents", async () => {
    await expect(insert("two", { venture: "v-a1", task: "t-a1" })).rejects.toThrow();
  });

  it("refuses no parent", async () => {
    await expect(insert("none", {})).rejects.toThrow();
  });

  it("refuses a role outside repo, docs, site and other", async () => {
    await expect(insert("wiki", { venture: "v-a1" }, "wiki")).rejects.toThrow();
  });

  it("refuses a size outside xs to xl, and takes a valid one", async () => {
    await expect(run(`UPDATE task SET size = 'xxl' WHERE id = 't-a1'`)).rejects.toThrow();
    await run(`UPDATE task SET size = 'xl' WHERE id = 't-a1'`);
  });
});

describe("0011_accounts over a database holding 0001 to 0010", () => {
  let old: Awaited<ReturnType<typeof testDb>>;
  let beforeRows: Record<string, unknown[]>;
  let beforeSchema: Row[];
  let afterRows: Record<string, unknown[]>;
  let afterSchema: Row[];

  const SECRET_TABLES = ["credential", "recovery_code", "challenge"];

  const tablesOf = async (): Promise<string[]> => (await old.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
  ).all<{ name: string }>()).results.map((r) => r.name);

  async function everyRow(names: string[]): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const name of names) out[name] = (await old.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all<Row>()).results;
    return out;
  }

  const schemaOf = async (): Promise<Row[]> => (await old.db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN ('credential', 'recovery_code', 'challenge') ORDER BY name`,
  ).all<Row>()).results;

  beforeAll(async () => {
    old = await testDb({ through: "0010_nest.sql" });
    const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
    for (const owner of ["owner-a", "owner-b"]) {
      await go(`INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, `v-${owner}`, owner, owner, AT, AT);
      await go(`INSERT INTO tenant (id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING`, owner, AT);
      await go(
        `INSERT INTO credential (id, owner, public_key, counter, transports, created_at) VALUES (?, ?, 'pk', 4, '["internal"]', ?)`,
        `cred-${owner}`, owner, AT,
      );
      await go(`INSERT INTO recovery_code (owner, code_hash, created_at) VALUES (?, 'hash', ?)`, owner, AT);
      await go(
        `INSERT INTO challenge (id, owner, purpose, challenge, expires_at) VALUES (?, ?, 'sign_in', 'c', '2999-01-01T00:00:00.000Z')`,
        `chal-${owner}`, owner,
      );
      await go(`INSERT INTO backup_run (id, owner, ran_at, ok, detail) VALUES (?, ?, ?, 1, 'it''s fine')`, `run-${owner}`, owner, AT);
    }
    const names = await tablesOf();
    beforeRows = await everyRow(names);
    beforeSchema = await schemaOf();
    for (const sql of migrationStatements((f) => f.startsWith("0011_"))) await old.db.prepare(sql).run();
    afterRows = await everyRow(names);
    afterSchema = await schemaOf();
  });
  afterAll(() => old.dispose());

  it("leaves every earlier table's rows exactly as they were", () => {
    expect(Object.keys(beforeRows).length).toBeGreaterThan(10);
    expect(beforeRows.venture).toHaveLength(2);
    expect(JSON.stringify(afterRows)).toBe(JSON.stringify(beforeRows));
  });

  it("keeps the exact schema text of the credential tables", () => {
    expect(beforeSchema.map((r) => r.name)).toEqual(SECRET_TABLES.slice().sort());
    expect(afterSchema).toEqual(beforeSchema);
  });

  it("adds the three tables, empty, and the two indexes", async () => {
    expect(await tablesOf()).toEqual(expect.arrayContaining(["account", "email_token", "throttle"]));
    for (const name of ["account", "email_token", "throttle"]) {
      const row = await old.db.prepare(`SELECT count(*) AS n FROM "${name}"`).first<{ n: number }>();
      expect(row?.n, name).toBe(0);
    }
    const indexes = (await old.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('email_token_by_owner', 'throttle_by_key') ORDER BY name`,
    ).all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toEqual(["email_token_by_owner", "throttle_by_key"]);
  });

  it("makes an account from an owner that already exists, with the foreign key on its tenant", async () => {
    await old.db.prepare(
      `INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('owner-a', 'a@example.test', 'h', ?, ?)`,
    ).bind(AT, AT).run();
    const row = await old.db.prepare(`SELECT session_generation, email_confirmed_at FROM account WHERE id = 'owner-a'`).first<Row>();
    expect(row).toEqual({ session_generation: 0, email_confirmed_at: null });
    const check = await old.db.prepare(`PRAGMA foreign_key_check`).all();
    expect(check.results).toEqual([]);
  });
});

describe("0012_plan over a database holding 0001 to 0011", () => {
  let old: Awaited<ReturnType<typeof testDb>>;
  let beforeRows: Record<string, Row[]>;
  let afterRows: Record<string, Row[]>;

  const tablesOf = async (): Promise<string[]> => (await old.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
  ).all<{ name: string }>()).results.map((r) => r.name);

  async function everyRow(names: string[]): Promise<Record<string, Row[]>> {
    const out: Record<string, Row[]> = {};
    for (const name of names) out[name] = (await old.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all<Row>()).results;
    return out;
  }

  beforeAll(async () => {
    old = await testDb({ through: "0011_accounts.sql" });
    const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
    for (const owner of ["owner-a", "owner-b"]) {
      await go(`INSERT INTO tenant (id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING`, owner, AT);
      await go(`INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, `top-${owner}`, owner, "Top", AT, AT);
      await go(
        `INSERT INTO venture (id, owner, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        `kid-${owner}`, owner, "Kid", `top-${owner}`, AT, AT,
      );
      await go(
        `INSERT INTO venture (id, owner, name, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)`,
        `old-${owner}`, owner, "Old", AT, AT, AT,
      );
      await go(
        `INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES (?, ?, 'pbkdf2$hash', ?, ?)`,
        owner, `${owner}@example.test`, AT, AT,
      );
    }
    const names = await tablesOf();
    beforeRows = await everyRow(names);
    for (const sql of migrationStatements((f) => f.startsWith("0012_"))) await old.db.prepare(sql).run();
    afterRows = await everyRow(names);
  });
  afterAll(() => old.dispose());

  it("leaves every earlier row as it was, tenant compared without plan", () => {
    expect(beforeRows.venture).toHaveLength(6);
    expect(beforeRows.account).toHaveLength(2);
    expect(Object.keys(afterRows)).toEqual(Object.keys(beforeRows));
    for (const name of Object.keys(beforeRows)) {
      const after = (afterRows[name] ?? []).map((r) => {
        if (name !== "tenant") return r;
        const { plan: _plan, ...rest } = r;
        return rest;
      });
      expect(JSON.stringify(after), name).toBe(JSON.stringify(beforeRows[name]));
    }
  });

  it("reads unlimited on every tenant", () => {
    expect((afterRows.tenant ?? []).map((r) => r.plan)).toEqual(["unlimited", "unlimited"]);
  });

  it("refuses a plan outside the two and takes free", async () => {
    await expect(old.db.prepare(`UPDATE tenant SET plan = 'gold' WHERE id = 'owner-a'`).run()).rejects.toThrow(/CHECK/i);
    await old.db.prepare(`UPDATE tenant SET plan = 'free' WHERE id = 'owner-a'`).run();
    const row = await old.db.prepare(`SELECT plan FROM tenant WHERE id = 'owner-a'`).first<{ plan: string }>();
    expect(row?.plan).toBe("free");
  });
});

describe("0013_owner_indexes over a database holding 0001 to 0012", () => {
  let old: Awaited<ReturnType<typeof testDb>>;

  const schemaOf = async (): Promise<Row[]> => (await old.db.prepare(
    `SELECT type, name, sql FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' ORDER BY name`,
  ).all<Row>()).results;
  const indexes = async (): Promise<string[]> => (await old.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT GLOB 'sqlite_*' ORDER BY name`,
  ).all<{ name: string }>()).results.map((r) => r.name);

  beforeAll(async () => {
    old = await testDb({ through: "0012_plan.sql" });
    const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
    await go(`INSERT INTO tenant (id, created_at) VALUES ('owner-a', ?)`, AT);
    await go(`INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES ('v', 'owner-a', 'Top', ?, ?)`, AT, AT);
    await go(`INSERT INTO project (id, owner, venture_id, name, created_at, updated_at) VALUES ('p', 'owner-a', 'v', 'P', ?, ?)`, AT, AT);
  });
  afterAll(() => old.dispose());

  it("adds only indexes, runs twice without complaint, and leaves every row and table as it was", async () => {
    const tables = await schemaOf();
    const had = await indexes();
    const before = (await old.db.prepare(`SELECT * FROM project ORDER BY rowid`).all<Row>()).results;
    for (let run = 0; run < 2; run++) {
      for (const sql of migrationStatements((f) => f.startsWith("0013_"))) await old.db.prepare(sql).run();
    }
    expect(await schemaOf()).toEqual(tables);
    expect((await old.db.prepare(`SELECT * FROM project ORDER BY rowid`).all<Row>()).results).toEqual(before);
    const added = (await indexes()).filter((name) => !had.includes(name));
    expect(added).toHaveLength(13);
    expect(added.every((name) => name.endsWith("_by_owner"))).toBe(true);
  });
});

describe("0028_first_run over a database holding 0001 to 0027", () => {
  let old: TestDb;
  beforeAll(async () => {
    old = await testDb({ through: "0027_front_setting.sql" });
    await old.db.prepare(`INSERT INTO tenant (id, created_at) VALUES ('owner-a', ?)`).bind(AT).run();
    await old.db.prepare(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('owner-a', 'a@example.test', 'h', ?, ?)`).bind(AT, AT).run();
    for (const sql of migrationStatements((f) => f.startsWith("0028_"))) await old.db.prepare(sql).run();
  });
  afterAll(() => old.dispose());

  it("leaves an existing account with no step and no tips, and its other columns as they were", async () => {
    expect(await old.db.prepare(`SELECT * FROM account WHERE id = 'owner-a'`).first<Row>())
      .toMatchObject({ email: "a@example.test", password_hash: "h", first_run_step: null, tips_seen: null });
  });

  it("holds a step and a tip list for an account made after it", async () => {
    await old.db.prepare(`INSERT INTO tenant (id, created_at) VALUES ('owner-b', ?)`).bind(AT).run();
    await old.db.prepare(`INSERT INTO account (id, email, password_hash, created_at, updated_at, first_run_step, tips_seen) VALUES ('owner-b', 'b@example.test', 'h', ?, ?, 1, '[]')`)
      .bind(AT, AT).run();
    expect(await old.db.prepare(`SELECT first_run_step, tips_seen FROM account WHERE id = 'owner-b'`).first<Row>())
      .toEqual({ first_run_step: 1, tips_seen: "[]" });
  });
});

describe("0027_front_setting over a database holding 0001 to 0026", () => {
  let old: TestDb;
  beforeAll(async () => {
    old = await testDb({ through: "0026_invite.sql" });
    for (const sql of migrationStatements((f) => f.startsWith("0027_"))) await old.db.prepare(sql).run();
  });
  afterAll(() => old.dispose());

  it("starts with no row, and holds one for the copy that is on, owned by the instance and unarchived", async () => {
    expect((await old.db.prepare(`SELECT COUNT(*) AS n FROM front_setting`).first<Row>())?.n).toBe(0);
    await old.db.prepare(`INSERT INTO front_setting (id, created_at) VALUES (1, ?)`).bind(AT).run();
    expect(await old.db.prepare(`SELECT owner, landing, archived_at FROM front_setting WHERE id = 1`).first<Row>())
      .toEqual({ owner: "instance", landing: 1, archived_at: null });
  });

  it("holds one row only, and landing is on or off", async () => {
    await expect(old.db.prepare(`INSERT INTO front_setting (id, created_at) VALUES (2, ?)`).bind(AT).run()).rejects.toThrow();
    await expect(old.db.prepare(`UPDATE front_setting SET landing = 2 WHERE id = 1`).run()).rejects.toThrow();
  });
});

describe("0026_invite over a database holding 0001 to 0025", () => {
  let old: TestDb;
  beforeAll(async () => {
    old = await testDb({ through: "0025_account_deletion.sql" });
    await old.db.prepare(`INSERT INTO tenant (id, created_at) VALUES ('owner-a', ?)`).bind(AT).run();
    await old.db.prepare(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('owner-a', 'a@example.test', 'h', ?, ?)`).bind(AT, AT).run();
    for (const sql of migrationStatements((f) => f.startsWith("0026_"))) await old.db.prepare(sql).run();
  });
  afterAll(() => old.dispose());

  it("leaves an existing account with no first name, and its other columns as they were", async () => {
    const row = await old.db.prepare(`SELECT * FROM account WHERE id = 'owner-a'`).first<Row>();
    expect(row).toMatchObject({ email: "a@example.test", password_hash: "h", first_name: null });
  });

  it("starts with no invitations, and holds one unused, unarchived and unaccepted", async () => {
    expect((await old.db.prepare(`SELECT COUNT(*) AS n FROM invite`).first<Row>())?.n).toBe(0);
    await old.db.prepare(`INSERT INTO invite (id, owner, first_name, expires_at, created_at) VALUES ('h', 'owner-a', 'Sam', ?, ?)`).bind(AT, AT).run();
    expect(await old.db.prepare(`SELECT used_at, accepted_by, archived_at FROM invite WHERE id = 'h'`).first<Row>())
      .toEqual({ used_at: null, accepted_by: null, archived_at: null });
  });

  it("refuses an empty first name", async () => {
    await expect(old.db.prepare(`INSERT INTO invite (id, owner, first_name, expires_at, created_at) VALUES ('e', 'owner-a', '', ?, ?)`).bind(AT, AT).run()).rejects.toThrow();
  });
});

describe("0025_account_deletion over a database holding 0001 to 0024", () => {
  let old: TestDb;
  beforeAll(async () => {
    old = await testDb({ through: "0024_two_step.sql" });
    await old.db.prepare(`INSERT INTO tenant (id, created_at) VALUES ('owner-a', ?)`).bind(AT).run();
    await old.db.prepare(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('owner-a', 'a@example.test', 'h', ?, ?)`).bind(AT, AT).run();
    for (const sql of migrationStatements((f) => f.startsWith("0025_"))) await old.db.prepare(sql).run();
  });
  afterAll(() => old.dispose());

  it("leaves an existing account with no deletion asked for, and its other columns as they were", async () => {
    const row = await old.db.prepare(`SELECT * FROM account WHERE id = 'owner-a'`).first<Row>();
    expect(row).toMatchObject({ email: "a@example.test", password_hash: "h", delete_on: null });
  });
});

describe("0029_keys over a database holding 0001 to 0028", () => {
  let old: TestDb;
  const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
  beforeAll(async () => {
    old = await testDb({ through: "0028_first_run.sql" });
    await go(`INSERT INTO tenant (id, created_at) VALUES ('owner-a', ?)`, AT);
    await go(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('owner-a', 'a@example.test', 'h', ?, ?)`, AT, AT);
    for (const sql of migrationStatements((f) => f.startsWith("0029_"))) await old.db.prepare(sql).run();
  });
  afterAll(() => old.dispose());

  it("leaves the account as it was and adds two empty tables", async () => {
    expect(await old.db.prepare(`SELECT * FROM account WHERE id = 'owner-a'`).first<Row>()).toMatchObject({ email: "a@example.test", password_hash: "h" });
    expect((await old.db.prepare(`SELECT COUNT(*) AS n FROM key_wrap`).first<Row>())?.n).toBe(0);
    expect((await old.db.prepare(`SELECT COUNT(*) AS n FROM key_pairing`).first<Row>())?.n).toBe(0);
  });

  it("holds a device row, a passkey row naming it, and a pairing", async () => {
    const insert = (id: string, kind: string, label: string, device: string | null, wrapped: string | null) => go(
      `INSERT INTO key_wrap (id, owner, key_ref, key_check, kind, label, device_id, wrapped, created_at) VALUES (?, 'owner-a', 'r', 'c', ?, ?, ?, ?, ?)`,
      id, kind, label, device, wrapped, AT,
    );
    await insert("d1", "device", "Chrome on Windows", null, null);
    await insert("p1", "passkey", "Face ID or fingerprint", "d1", "iv.data");
    await go(`INSERT INTO key_pairing (id, owner, expires_at, created_at) VALUES ('pair', 'owner-a', ?, ?)`, LATER, AT);
    expect(await old.db.prepare(`SELECT kind, device_id, archived_at FROM key_wrap WHERE id = 'p1'`).first<Row>())
      .toEqual({ kind: "passkey", device_id: "d1", archived_at: null });
    expect(await old.db.prepare(`SELECT public_part, sealed, archived_at FROM key_pairing WHERE id = 'pair'`).first<Row>())
      .toEqual({ public_part: null, sealed: null, archived_at: null });
  });

  it("refuses a kind outside the four, a label over 60, a wrapped copy over 512 and a row for no account", async () => {
    const row = (kind: string, label: string, wrapped: string | null, owner = "owner-a") => go(
      `INSERT INTO key_wrap (id, owner, key_ref, key_check, kind, label, wrapped, created_at) VALUES (?, ?, 'r', 'c', ?, ?, ?, ?)`,
      crypto.randomUUID(), owner, kind, label, wrapped, AT,
    );
    await expect(row("owner", "x", null)).rejects.toThrow();
    await expect(row("device", "x".repeat(61), null)).rejects.toThrow();
    await expect(row("device", "", null)).rejects.toThrow();
    await expect(row("recovery", "x", "a".repeat(513))).rejects.toThrow();
    await expect(row("device", "x", null, "nobody")).rejects.toThrow();
    await row("recovery", "x".repeat(60), "a".repeat(512));
  });

  it("indexes each table by owner and archived_at", async () => {
    const names = (await old.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('key_wrap_by_owner', 'key_pairing_by_owner')`).all<Row>()).results.map((r) => r.name);
    expect(names.sort()).toEqual(["key_pairing_by_owner", "key_wrap_by_owner"]);
  });
});

describe("0024_two_step over a database holding 0001 to 0023", () => {
  let old: TestDb;
  beforeAll(async () => {
    old = await testDb({ through: "0023_account_settings.sql" });
    await old.db.prepare(`INSERT INTO tenant (id, created_at) VALUES ('owner-a', ?)`).bind(AT).run();
    await old.db.prepare(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('owner-a', 'a@example.test', 'h', ?, ?)`).bind(AT, AT).run();
    for (const sql of migrationStatements((f) => f.startsWith("0024_"))) await old.db.prepare(sql).run();
  });
  afterAll(() => old.dispose());

  it("leaves an existing account with 2-step off and no backup codes, and its other columns as they were", async () => {
    const row = await old.db.prepare(`SELECT * FROM account WHERE id = 'owner-a'`).first<Row>();
    expect(row).toMatchObject({ email: "a@example.test", password_hash: "h", two_step_secret: null, two_step_on_at: null, backup_codes: "[]" });
  });
});
