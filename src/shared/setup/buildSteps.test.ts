import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonc } from "../../../tests/jsonc.js";
import { ROOT, isTestCode, walk } from "../../../tests/walk.js";
import { createCloudflare } from "./cloudflareApi.js";
import {
  CRON,
  DATA_BINDING,
  DEFAULT_TIME_ZONE,
  OWNER_ID,
  RUN_WORKER_FIRST,
  STEP_NAMES,
  createBuild,
  newClaimCode,
  type BuildBundle,
  type BuildPlan,
  type StepName,
} from "./buildSteps.js";
import { createFakeCloudflare, type FakeCloudflare } from "./fakeCloudflare.js";
import { buildManifest, type ReleaseFile } from "./releaseManifest.js";

const TOKEN = "tok-test-1";
const FROM = "https://helper.example.test";
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string): ReleaseFile => ({ path, bytes: enc(text) });

async function bundle(version = "0.1.0"): Promise<BuildBundle> {
  const worker = file("worker/index.js", "export default { fetch() { return new Response('ok'); } };");
  const client = [
    file("/index.html", "<html></html>"),
    file("/assets/app.js", "console.log(1)"),
    file("/assets/app.css", "body{}"),
    file("/manifest.webmanifest", "{}"),
    file("/icons/a.png", "png-bytes"),
  ];
  const migrations = [file("0001_a.sql", "CREATE TABLE a (x TEXT);"), file("0002_b.sql", "CREATE TABLE b (x TEXT);\n-- last line")];
  const manifest = await buildManifest({
    version,
    issuedAt: "2026-11-25T00:00:00.000Z",
    notesFile: `# Notes\n\n## ${version}\n\nFirst.\n`,
    compatibilityDate: "2026-09-11",
    bindings: [],
    variables: [],
    worker,
    client,
    migrations,
  });
  return { manifest, worker, client, migrations };
}

interface Rig {
  fake: FakeCloudflare;
  plan: BuildPlan;
  lines: string[];
  build: ReturnType<typeof createBuild>;
}

async function rig(over: Partial<BuildPlan> = {}, fake = createFakeCloudflare({ token: TOKEN })): Promise<Rig> {
  const lines: string[] = [];
  const plan: BuildPlan = {
    api: createCloudflare({ fetch: fake.fetch, token: TOKEN }),
    accountId: "acct-test",
    name: "vemi-test",
    from: FROM,
    claim: newClaimCode(),
    bundle: await bundle(),
    log: (line) => lines.push(line),
    ...over,
  };
  return { fake, plan, lines, build: createBuild(plan) };
}

/** The call a failure is injected on, per step. */
const FAIL_ON: Record<StepName, string> = {
  Database: "database.create",
  "Data layout": "query",
  "App files": "assets.upload",
  App: "worker.upload",
  "Reminder clock": "schedules.set",
  Address: "workers-dev.set",
};

/** The change each step makes; a finished step must not make it again. */
const MADE_BY: Record<StepName, string> = {
  Database: "database.create",
  "Data layout": "query.write",
  "App files": "assets.upload",
  App: "worker.upload",
  "Reminder clock": "schedules.set",
  Address: "workers-dev.set",
};

describe("a full run", () => {
  it("passes all six steps against the fake and leaves a working copy", async () => {
    const { fake, build, plan } = await rig();
    const steps: string[] = [];
    const outcome = await build.run([], (step, state) => state === "done" && steps.push(step));
    expect(outcome).toEqual({ ok: true, address: "https://vemi-test.test-sub.workers.dev", done: [...STEP_NAMES] });
    expect(steps).toEqual([...STEP_NAMES]);
    expect([...STEP_NAMES]).toEqual(["Database", "Data layout", "App files", "App", "Reminder clock", "Address"]);

    const db = [...fake.databases.values()].find((d) => d.name === "vemi-test")!;
    expect(db.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(db.migrationSql[0]).toBe("CREATE TABLE a (x TEXT);\n");
    // A last line that is a comment cannot swallow the record that follows it.
    expect(db.migrationSql[1]).toBe("CREATE TABLE b (x TEXT);\n-- last line\n;\n");
    expect(fake.held.size).toBe(plan.bundle.client.length);

    const worker = fake.workers.get("vemi-test")!;
    expect(worker.schedules).toEqual(["* * * * *"]);
    expect(worker.workersDev).toBe(true);
  });

  it("uploads the Worker with its bindings, its live-room migration, one cron and one secret", async () => {
    const { fake, build, plan } = await rig();
    await build.run();
    const worker = fake.workers.get("vemi-test")!;
    const db = [...fake.databases.values()][0]!;
    const bindings = worker.metadata["bindings"] as Record<string, string>[];

    expect(bindings).toContainEqual({ type: "d1", name: DATA_BINDING, id: db.id });
    expect(DATA_BINDING).toBe("D" + "B");
    expect(bindings).toContainEqual({ type: "durable_object_namespace", name: "LIVE", class_name: "Live" });
    expect(bindings).toContainEqual({ type: "assets", name: "ASSETS" });
    expect(bindings).toContainEqual({ type: "plain_text", name: "OWNER", text: "owner" });
    expect(bindings).toContainEqual({ type: "plain_text", name: "TIME_ZONE", text: "UTC" });
    expect(bindings).toContainEqual({ type: "plain_text", name: "SETUP_FROM", text: FROM });
    expect(bindings).toContainEqual({ type: "secret_text", name: "SETUP_CLAIM", text: plan.claim });
    expect(bindings.filter((b) => b["type"] === "secret_text").map((b) => b["name"])).toEqual(["SETUP_CLAIM"]);

    expect(worker.metadata["migrations"]).toEqual({ new_tag: "v1", steps: [{ new_sqlite_classes: ["Live"] }] });
    expect(worker.metadata["main_module"]).toBe("index.js");
    expect(worker.metadata["compatibility_date"]).toBe("2026-09-11");
    expect(worker.metadata["assets"].config.not_found_handling).toBe("single-page-application");
    expect(worker.schedules).toEqual([CRON]);
    expect(CRON).toBe("* * * * *");
  });

  it("makes a fresh claim code each time, long and URL safe", () => {
    const a = newClaimCode();
    const b = newClaimCode();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("makes no create or upload call on a second run", async () => {
    const { fake, build } = await rig();
    await build.run();
    fake.clearRequests();
    const second = createBuild({ ...(await rig({}, fake)).plan, claim: newClaimCode() });
    const outcome = await second.run();
    expect(outcome.ok).toBe(true);
    expect(fake.mutations()).toEqual([]);
    expect(fake.requests.map((r) => r.label).filter((l) => /create|upload|set|write/.test(l))).toEqual([]);
    expect([...fake.databases.values()]).toHaveLength(1);
  });

  it("applies only the migrations not yet recorded", async () => {
    const fake = createFakeCloudflare({ token: TOKEN });
    const db = fake.seedDatabase("vemi-test", ["d1_migrations", "a"]);
    db.applied.push("0001_a.sql");
    const { build } = await rig({}, fake);
    expect((await build.run()).ok).toBe(true);
    expect(db.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(db.migrationSql).toHaveLength(1);
  });

  it("makes the account's address when it has none, and leaves one it has", async () => {
    const none = createFakeCloudflare({ token: TOKEN, subdomain: null });
    const first = await rig({ subdomain: "mine" }, none);
    expect(await first.build.run()).toMatchObject({ ok: true, address: "https://vemi-test.mine.workers.dev" });
    expect(none.subdomain).toBe("mine");
    const some = await rig({ subdomain: "ignored" });
    expect(await some.build.run()).toMatchObject({ address: "https://vemi-test.test-sub.workers.dev" });
    expect(some.fake.subdomain).toBe("test-sub");
  });

  it("does not send the live-room migration again to a Worker that exists", async () => {
    const fake = createFakeCloudflare({ token: TOKEN });
    fake.seedWorker("vemi-test", ["vemi:0.0.9"]);
    const { build } = await rig({}, fake);
    expect((await build.run()).ok).toBe(true);
    expect(fake.workers.get("vemi-test")!.metadata["migrations"]).toBeUndefined();
    expect(fake.workers.get("vemi-test")!.metadata["tags"]).toEqual(["vemi:0.1.0"]);
  });
});

describe("a failure at each step", () => {
  for (const step of STEP_NAMES) {
    it(`stops at ${step} with that step named, and a rerun finishes from it`, async () => {
      const { fake, build, lines } = await rig();
      fake.failOnce(FAIL_ON[step], 500);
      const outcome = await build.run();
      const before = STEP_NAMES.slice(0, STEP_NAMES.indexOf(step));
      expect(outcome).toEqual({ ok: false, step, reason: expect.stringMatching(/^Cloudflare would not .+\.$/), done: before });
      expect(lines).toContain(`${step}: failed`);
      expect(lines).not.toContain(`${STEP_NAMES[STEP_NAMES.indexOf(step) + 1] ?? "none"}: start`);

      // The page keeps the finished steps and runs again from the failed one.
      fake.clearRequests();
      const again = await rig({}, fake);
      const rerun = await again.build.run(before);
      expect(rerun.ok).toBe(true);
      const made = fake.mutations().map((r) => r.label);
      for (const name of before) expect(made).not.toContain(MADE_BY[name]);
    });
  }

  it("also finishes when the page has forgotten its progress", async () => {
    const { fake, build } = await rig();
    fake.failOnce("worker.upload", 500);
    expect((await build.run()).ok).toBe(false);
    const again = await rig({}, fake);
    expect((await again.build.run()).ok).toBe(true);
    expect([...fake.databases.values()]).toHaveLength(1);
    expect(fake.workers.get("vemi-test")!.schedules).toEqual([CRON]);
  });

  it("skips a step it is told is done without a request", async () => {
    const { fake, build } = await rig();
    await build.run();
    fake.clearRequests();
    const again = await rig({}, fake);
    const outcome = await again.build.run(["Database", "Data layout", "App files", "App", "Reminder clock"]);
    expect(outcome.ok).toBe(true);
    expect(new Set(fake.requests.map((r) => r.label))).toEqual(new Set(["subdomain.get", "workers-dev.get"]));
  });

  it("sends nothing at all for a run that is all done but the address read", async () => {
    const { fake, build } = await rig();
    fake.clearRequests();
    const skipped = await build.run([...STEP_NAMES]);
    expect(skipped.ok).toBe(true);
    expect(fake.requests.map((r) => r.label)).toEqual(["subdomain.get"]);
  });

  it("names a step in a plain sentence when something unexpected breaks it", async () => {
    const { plan } = await rig();
    const broken = createBuild({ ...plan, api: { ...plan.api, findDatabase: async () => Promise.reject(new TypeError(`boom ${TOKEN}`)) } });
    const outcome = await broken.run();
    expect(outcome).toMatchObject({ ok: false, step: "Database", reason: "Something went wrong at Database." });
  });
});

describe("a name that clashes", () => {
  it("shows an app that VEMI did not make before anything is built", async () => {
    const fake = createFakeCloudflare({ token: TOKEN });
    fake.seedWorker("vemi-test", ["something-else"]);
    const { build } = await rig({}, fake);
    expect(await build.preflight()).toEqual({ ok: false, reason: "This account already has an app called vemi-test that VEMI did not make." });
    expect(fake.mutations()).toEqual([]);
  });

  it("shows a database that VEMI did not make", async () => {
    const fake = createFakeCloudflare({ token: TOKEN });
    fake.seedDatabase("vemi-test", ["invoices"]);
    const { build } = await rig({}, fake);
    expect(await build.preflight()).toEqual({ ok: false, reason: "This account already has a database called vemi-test that VEMI did not make." });
  });

  it("shows a name Cloudflare would not take", async () => {
    const { build } = await rig({ name: "My Copy" });
    const result = await build.preflight();
    expect(result.ok).toBe(false);
  });

  it("lets a copy VEMI made earlier carry on, and shows the address it will have", async () => {
    const fake = createFakeCloudflare({ token: TOKEN });
    fake.seedDatabase("vemi-test", ["d1_migrations", "a"]);
    fake.seedWorker("vemi-test", ["vemi:0.0.9"]);
    const { build } = await rig({}, fake);
    expect(await build.preflight()).toEqual({ ok: true, address: "https://vemi-test.test-sub.workers.dev" });
  });

  it("is clear on a clean account, and reads only", async () => {
    const { build, fake } = await rig();
    expect(await build.preflight()).toEqual({ ok: true, address: "https://vemi-test.test-sub.workers.dev" });
    expect(fake.mutations()).toEqual([]);
  });
});

describe("the key", () => {
  it("is in no thrown message and no recorded log line", async () => {
    const { fake, build, lines } = await rig();
    const thrown: string[] = [];
    const api = createCloudflare({ fetch: fake.fetch, token: TOKEN });
    fake.failOnce("database.create", 400, `bad key ${TOKEN}`);
    const outcome = await build.run();
    if (!outcome.ok) thrown.push(outcome.reason);
    for (const call of [() => api.verifyToken(), () => createCloudflare({ fetch: fake.fetch, token: "wrong" }).verifyToken()]) {
      fake.failOnce("token.verify", 401, `rejected ${TOKEN}`);
      await call().catch((error: Error) => thrown.push(error.message, error.stack ?? ""));
    }
    await build.run();
    expect(thrown.length).toBeGreaterThan(1);
    for (const text of [...thrown, ...lines, ...fake.log, JSON.stringify(fake.requests)]) expect(text).not.toContain(TOKEN);
    // The worker upload carries the claim code, never the key.
    expect(JSON.stringify(fake.workers.get("vemi-test")!.metadata)).not.toContain(TOKEN);
  });

  it("is sent only as the credential of calls to the API, and the upload key goes only to the upload", async () => {
    const { fake, build } = await rig();
    await build.run();
    for (const request of fake.requests) expect(request.credential).toBe(request.label === "assets.upload" ? "upload" : "key");
  });
});

describe("what leaves this folder", () => {
  const sources = walk("src/shared/setup", [".ts"]).filter((f) => !isTestCode(f));

  it("goes through the injected fetch and nothing else", () => {
    expect(sources).toEqual(
      expect.arrayContaining(["src/shared/setup/buildSteps.ts", "src/shared/setup/cloudflareApi.ts", "src/shared/setup/tokenLink.ts"]),
    );
    for (const source of sources.filter((f) => !f.endsWith("fakeCloudflare.ts"))) {
      const text = readFileSync(join(ROOT, source), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      expect(text, source).not.toMatch(/(^|[^.\w])fetch\s*\(/);
      expect(text, source).not.toMatch(/globalThis\.fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(|\brequire\s*\(/);
    }
    expect(readFileSync(join(ROOT, "src/shared/setup/cloudflareApi.ts"), "utf8")).toContain("options.fetch(");
  });

  it("does not hold the fake in the app or the relay", () => {
    const users = [...walk("src", [".ts", ".tsx"]), ...walk("scripts", [".mjs", ".js"])]
      .filter((f) => !isTestCode(f) && !f.endsWith("fakeCloudflare.ts"))
      .filter((f) => readFileSync(join(ROOT, f), "utf8").includes("fakeCloudflare"));
    expect(users).toEqual([]);
  });
});

describe("the copy it builds", () => {
  it("matches wrangler.jsonc", () => {
    const config = readJsonc<{
      compatibility_date: string;
      assets: { run_worker_first: string[]; not_found_handling: string };
      triggers: { crons: string[] };
      vars: Record<string, string>;
      durable_objects: { bindings: { name: string; class_name: string }[] };
      migrations: { tag: string; new_sqlite_classes: string[] }[];
    }>("wrangler.jsonc");
    expect(config.triggers.crons).toEqual([CRON]);
    expect(config.vars["OWNER"]).toBe(OWNER_ID);
    expect(config.vars["TIME_ZONE"]).toBe(DEFAULT_TIME_ZONE);
    expect(config.assets.not_found_handling).toBe("single-page-application");
    // Every path the config runs the Worker for is one the build sets; the build may add more.
    for (const path of config.assets.run_worker_first) expect(RUN_WORKER_FIRST).toContain(path);
    expect(config.durable_objects.bindings).toEqual([{ name: "LIVE", class_name: "Live" }]);
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Live"] }]);
  });
});
