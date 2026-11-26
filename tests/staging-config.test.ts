import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonc } from "./jsonc.js";
import { ROOT } from "./walk.js";

/**
 * The committed `wrangler.jsonc` is a stranger's copy: it names no account, no domain, no database
 * ID and no origin, carries the one shared cron tick, and binds no mail. Andy's own account,
 * databases and domains are not here (the environments task keeps them in a git-ignored file and
 * tests the merge of that file's example against the old staging rules).
 */

type WranglerConfig = {
  account_id?: string;
  workers_dev?: boolean;
  routes?: readonly unknown[];
  env?: unknown;
  d1_databases: readonly { binding: string; database_name: string; database_id?: string; migrations_dir?: string }[];
  vars: Record<string, string>;
  triggers?: { crons: readonly string[] };
};

const config = readJsonc<WranglerConfig>("wrangler.jsonc");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("the committed wrangler.jsonc is a stranger's copy", () => {
  it("names no account, no route and no environment", () => {
    expect(config.account_id).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.env).toBeUndefined();
  });

  it("serves from workers.dev", () => {
    expect(config.workers_dev).toBe(true);
  });

  it("binds the D1 database DB by name, with no database ID", () => {
    expect(config.d1_databases).toHaveLength(1);
    const db = config.d1_databases[0]!;
    expect(db.binding).toBe("DB");
    expect(db.database_name).toBe("vemi");
    expect(db.database_id).toBeUndefined();
    expect(db.migrations_dir).toBe("migrations");
  });

  it("sets no ORIGIN, and defaults OWNER and TIME_ZONE", () => {
    expect(config.vars.ORIGIN).toBeUndefined();
    expect(config.vars.OWNER).toBe("owner");
    expect(config.vars.TIME_ZONE).toBe("UTC");
  });

  it("binds no mail, and sets no sending address", () => {
    const named = (keys: string[]) => keys.filter((k) => /mail/i.test(k));
    expect(named(Object.keys(config))).toEqual([]);
    expect(named(Object.keys(config.vars))).toEqual([]);
  });

  it("schedules exactly one cron, the every-minute tick", () => {
    expect(config.triggers?.crons).toEqual(["* * * * *"]);
  });

  it("carries no BACKUP_* vars", () => {
    expect(Object.keys(config.vars).filter((k) => k.startsWith("BACKUP_"))).toEqual([]);
  });
});

describe("the scripts", () => {
  it("builds the client, then dry-runs the Worker", () => {
    expect(pkg.scripts.build).toBe("vite build && wrangler deploy --dry-run --outdir dist/worker");
  });

  it("runs the whole gate, build, types, lint and tests, in verify", () => {
    expect(pkg.scripts.verify).toBe("pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run test");
  });

  it("deploys by applying D1 migrations to DB remotely, then deploying, and nothing else", () => {
    expect(pkg.scripts.deploy).toBe("wrangler d1 migrations apply DB --remote && wrangler deploy");
  });
});
