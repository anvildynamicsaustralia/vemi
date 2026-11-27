import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script with JSDoc, no declaration file
import { assertReal, assertRealFront, merge, mergeFront } from "../scripts/andy-config.mjs";
import { readJsonc } from "./jsonc.js";
import { ROOT } from "./walk.js";

/**
 * Andy's environments are the committed `wrangler.jsonc` plus a git-ignored `andy.local.json`,
 * merged by `scripts/andy-config.mjs` into a git-ignored `wrangler.andy.jsonc`. These are the old
 * staging rules, run against the merge of the example file, plus the rule that no real account or
 * database ID is ever tracked.
 */

type Route = { pattern: string; custom_domain?: boolean };
type Merged = {
  name: string;
  account_id?: string;
  workers_dev: boolean;
  routes: readonly Route[];
  d1_databases: readonly { binding: string; database_id: string; database_name: string; migrations_dir?: string }[];
  durable_objects: { bindings: readonly { name: string; class_name: string }[] };
  migrations: readonly unknown[];
  vars: Record<string, string>;
  triggers: { crons: readonly string[] };
  main: string;
};
type Local = {
  account_id: string;
  owner: string;
  production: { database_id: string; domain: string; origin: string };
  staging: { database_id: string; domain: string; origin: string };
};

const base = readJsonc<Record<string, unknown>>("wrangler.jsonc");
const example = JSON.parse(readFileSync(join(ROOT, "scripts/andy.local.example.json"), "utf8")) as Local;
const prod = merge(base, example, "production") as Merged;
const stag = merge(base, example, "staging") as Merged;

// Filled the way Andy fills it, built at run time so no real-looking ID is written in a tracked file.
const rep = (n: number, c: string) => c.repeat(n);
const uuid = (a: string, b: string, c: string, d: string, e: string) => [rep(8, a), rep(4, b), rep(4, c), rep(4, d), rep(12, e)].join("-");
const filled: Local = {
  account_id: rep(32, "a"),
  owner: "andy",
  production: { database_id: uuid("1", "2", "3", "4", "5"), domain: "app.example.test", origin: "https://app.example.test" },
  staging: { database_id: uuid("6", "7", "8", "9", "b"), domain: "staging.example.test", origin: "https://staging.example.test" },
};

describe("merge of the example file", () => {
  it("names Workers vemi and vemi-staging, each with workers.dev off", () => {
    expect(prod.name).toBe("vemi");
    expect(stag.name).toBe("vemi-staging");
    expect(prod.workers_dev).toBe(false);
    expect(stag.workers_dev).toBe(false);
  });

  it("names its own database, not production's", () => {
    const p = prod.d1_databases[0]!;
    const s = stag.d1_databases[0]!;
    expect(p.binding).toBe("DB");
    expect(s.binding).toBe("DB");
    expect(s.database_id).not.toBe(p.database_id);
    expect(s.database_name).not.toBe(p.database_name);
    expect(s.database_name).toBe("vemi-staging");
    expect(p.database_name).toBe("vemi");
    expect(s.migrations_dir).toBe("migrations");
  });

  it("has its own origin, and OWNER andy in both", () => {
    expect(stag.vars.ORIGIN).not.toBe(prod.vars.ORIGIN);
    expect(prod.vars.OWNER).toBe("andy");
    expect(stag.vars.OWNER).toBe("andy");
    expect(prod.vars.TIME_ZONE).toBe((base.vars as Record<string, string>).TIME_ZONE);
  });

  it("binds no mail in either environment, and sets no sending address", () => {
    const named = (keys: string[]) => keys.filter((k) => /mail/i.test(k));
    for (const c of [prod, stag]) {
      expect(named(Object.keys(c))).toEqual([]);
      expect(named(Object.keys(c.vars))).toEqual([]);
    }
  });

  it("schedules exactly one cron, the every-minute tick, in each environment", () => {
    expect(prod.triggers.crons).toEqual(["* * * * *"]);
    expect(stag.triggers.crons).toEqual(["* * * * *"]);
  });

  it("restates the Durable Object and its migration in each environment", () => {
    for (const c of [prod, stag]) {
      expect(c.durable_objects.bindings).toEqual([{ name: "LIVE", class_name: "Live" }]);
      expect(c.migrations).toEqual(base.migrations);
    }
  });

  it("carries no BACKUP_* vars", () => {
    for (const c of [prod, stag]) expect(Object.keys(c.vars).filter((k) => k.startsWith("BACKUP_"))).toEqual([]);
  });

  it("pins the account in both", () => {
    expect(prod.account_id).toBe(example.account_id);
    expect(stag.account_id).toBe(example.account_id);
  });

  it("gives each environment exactly one custom domain, and two different ones", () => {
    expect(prod.routes).toHaveLength(1);
    expect(stag.routes).toHaveLength(1);
    expect(prod.routes[0]!.custom_domain).toBe(true);
    expect(stag.routes[0]!.custom_domain).toBe(true);
    expect(prod.routes[0]!.pattern).not.toBe(stag.routes[0]!.pattern);
  });

  it("sets ORIGIN to the https address of its own route", () => {
    expect(prod.vars.ORIGIN).toBe("https://" + prod.routes[0]!.pattern);
    expect(stag.vars.ORIGIN).toBe("https://" + stag.routes[0]!.pattern);
  });

  it("keeps the rest of the committed config, and does not change it", () => {
    expect(prod.main).toBe(base.main);
    expect(base.workers_dev).toBe(true);
    expect(base.name).toBe("vemi");
    expect(base.account_id).toBeUndefined();
    expect(base.routes).toBeUndefined();
  });

  it("refuses a local file that misses a field or whose origin is not its domain", () => {
    expect(() => merge(base, { ...example, account_id: "" }, "production")).toThrow(/account_id/);
    expect(() => merge(base, { ...example, production: { ...example.production, origin: "https://other.test" } }, "production")).toThrow(/origin/);
    expect(() => merge(base, example, "preview")).toThrow(/production or staging/);
  });
});

describe("a filled andy.local.json", () => {
  const p = merge(base, filled, "production") as Merged;
  const s = merge(base, filled, "staging") as Merged;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("passes the real-values check, and the example does not", () => {
    expect(() => assertReal(filled)).not.toThrow();
    expect(() => assertReal(example)).toThrow(/account_id/);
  });

  it("pins the account", () => {
    expect(p.account_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uses two different databases", () => {
    const a = p.d1_databases[0]!.database_id;
    const b = s.d1_databases[0]!.database_id;
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
    expect(() => assertReal({ ...filled, staging: { ...filled.staging, database_id: filled.production.database_id } })).toThrow(/different/);
  });

  it("refuses the same domain for both environments", () => {
    const same = { ...filled, staging: { ...filled.staging, domain: filled.production.domain, origin: filled.production.origin } };
    expect(() => assertReal(same)).toThrow(/different/);
  });
});

describe("the scripts", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const verify = "pnpm run verify && ";

  it("runs the whole gate before either deploy", () => {
    expect(pkg.scripts.verify).toBe("pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run test");
    expect(pkg.scripts["deploy:production"]!.startsWith(verify)).toBe(true);
    expect(pkg.scripts["deploy:staging"]!.startsWith(verify)).toBe(true);
  });

  it("deploys production only through the staging gate, after verify", () => {
    const s = pkg.scripts["deploy:production"]!;
    expect(s.startsWith(verify + "node scripts/proven-on-staging.mjs && ")).toBe(true);
    expect(s.indexOf("proven-on-staging")).toBeLessThan(s.indexOf("wrangler deploy"));
  });

  it("builds the config, migrates DB remotely and deploys from wrangler.andy.jsonc, in both", () => {
    for (const [name, env] of [["deploy:production", "production"], ["deploy:staging", "staging"]] as const) {
      const s = pkg.scripts[name]!;
      expect(s).toContain(`node scripts/andy-config.mjs ${env} && `);
      expect(s).toContain("wrangler d1 migrations apply DB --remote --config wrangler.andy.jsonc && ");
      expect(s.endsWith("wrangler deploy --config wrangler.andy.jsonc")).toBe(true);
    }
  });

  it("leaves the stranger's deploy as it is", () => {
    expect(pkg.scripts.deploy).toBe("wrangler d1 migrations apply DB --remote && wrangler deploy");
  });

  it("has the staging gate read only staging", () => {
    const gate = readFileSync(join(ROOT, "scripts/proven-on-staging.mjs"), "utf8");
    expect(gate).toContain("--remote");
    expect(gate).not.toMatch(/"execute"|"export"|"apply"|"deploy"/);
  });
});

describe("the front target", () => {
  const frontBase = readJsonc<Record<string, unknown>>("wrangler.front.jsonc");
  const withFront = { ...filled, front: { kv_namespace_id: rep(32, "c"), domain: "get.example.test" } };
  const merged = mergeFront(frontBase, withFront) as {
    name: string;
    main: string;
    account_id: string;
    workers_dev: boolean;
    routes: readonly Route[];
    kv_namespaces: { binding: string; id: string }[];
    d1_databases?: unknown;
    durable_objects?: unknown;
    triggers?: unknown;
  };

  it("merges the KV namespace id, the domain and the account into the committed front config", () => {
    expect(merged.name).toBe("vemi-front");
    expect(merged.main).toBe("src/front/index.ts");
    expect(merged.account_id).toBe(withFront.account_id);
    expect(merged.workers_dev).toBe(false);
    expect(merged.routes).toEqual([{ pattern: "get.example.test", custom_domain: true }]);
    expect(merged.kv_namespaces).toEqual([{ binding: "RELAY_DAY", id: withFront.front.kv_namespace_id }]);
  });

  it("adds no D1, Durable Object or cron, and does not change the committed config", () => {
    expect(merged.d1_databases).toBeUndefined();
    expect(merged.durable_objects).toBeUndefined();
    expect(merged.triggers).toBeUndefined();
    expect((frontBase.kv_namespaces as { id?: string }[])[0]!.id).toBeUndefined();
    expect(frontBase.account_id).toBeUndefined();
  });

  it("refuses a local file that misses a front field, and the example's words", () => {
    expect(() => mergeFront(frontBase, { ...filled })).toThrow(/front\.kv_namespace_id/);
    expect(() => mergeFront(frontBase, { ...withFront, front: { ...withFront.front, domain: "" } })).toThrow(/front\.domain/);
    expect(() => assertRealFront(example)).toThrow(/account_id/);
    expect(() => assertRealFront({ ...filled, front: { kv_namespace_id: "your id", domain: "get.example.test" } })).toThrow(/kv_namespace_id/);
    expect(() => assertRealFront({ ...withFront, front: { ...withFront.front, domain: "nope" } })).toThrow(/domain/);
    expect(() => assertRealFront(withFront)).not.toThrow();
  });

  it("has the example name a front section, with no real id in it", () => {
    const front = (example as Local & { front: { kv_namespace_id: string; domain: string } }).front;
    expect(front.kv_namespace_id).not.toMatch(/^[0-9a-f]{32}$/);
    expect(front.domain).toMatch(/\.example\.test$/);
  });

  it("leaves the production and staging merge refusing the front", () => {
    expect(() => merge(base, example, "front")).toThrow(/production or staging/);
  });

  it("gets its scripts: build:front, and a deploy gated like the others and run from wrangler.andy.jsonc", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:front"]).toBe("pnpm run release && node scripts/build-front.mjs");
    const s = pkg.scripts["deploy:front"]!;
    expect(s.startsWith("pnpm run verify && ")).toBe(true);
    expect(s).toContain("node scripts/andy-config.mjs front && ");
    expect(s.endsWith("wrangler deploy --config wrangler.andy.jsonc")).toBe(true);
    expect(s.indexOf("build:front")).toBeLessThan(s.indexOf("wrangler deploy"));
  });
});

describe("nothing real is tracked", () => {
  const ACCOUNT = /\b[0-9a-f]{32}\b/;
  const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && !f.startsWith(".works/") && !f.startsWith("data/") && f !== "pnpm-lock.yaml")
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip)$/i.test(f));

  it("keeps andy.local.json and the merged wrangler.andy files out of git", () => {
    const names = ["andy.local.json", "wrangler.andy.jsonc", "wrangler.andy.staging.jsonc", "wrangler.andy.production.jsonc"];
    const ignored = execFileSync("git", ["check-ignore", ...names], { cwd: ROOT, encoding: "utf8" });
    expect(ignored.trim().split("\n")).toHaveLength(names.length);
  });

  it("holds no account ID and no D1 UUID in wrangler.jsonc", () => {
    const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
    expect(text).not.toMatch(ACCOUNT);
    expect(text).not.toMatch(UUID);
  });

  it("holds no account ID and no D1 UUID in any tracked file", () => {
    const hits = tracked.filter((f) => {
      const text = readFileSync(join(ROOT, f), "utf8");
      // A fixture id of zeros is a test value, not a database. The root .infisical.json names the
      // Infisical project, which opens nothing without a login: only its workspaceId may be a UUID.
      const checked = f === ".infisical.json" ? text.replace(/"workspaceId":\s*"[0-9a-f-]{36}"/, "") : text;
      return ACCOUNT.test(checked) || UUID.test(checked.replaceAll(/\b00000000-[0-9a-f-]{27}\b/g, ""));
    });
    expect(hits).toEqual([]);
  });

  it("keeps .infisical.json to the project ID and the default environment", () => {
    const config = JSON.parse(readFileSync(join(ROOT, ".infisical.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(["defaultEnvironment", "workspaceId"]);
    expect(config["defaultEnvironment"]).toBe("dev");
  });
});
