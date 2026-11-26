import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NOT_CHECKED, type UpdateAnswer } from "./selfUpdate.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { ORIGIN, T0, TOKEN, makeKeys, makeRelease, makeRig, type Keys, type Rig, type RigOptions } from "./testing/updateRig.js";

/**
 * The update steps, against the fake Cloudflare and a release signed in memory: a good run ends
 * with the new version deployed, a second pass changes nothing, every call can fail and the run
 * resumes, and nothing unchecked reaches Cloudflare.
 */

let keys: Keys;
let shared: TestDb;
const own: TestDb[] = [];

beforeAll(async () => {
  keys = await makeKeys();
  shared = await testDb();
});
afterAll(async () => {
  await shared.dispose();
  while (own.length > 0) await own.pop()!.dispose();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Rigs share one database, each starting with no open run; a rig with no kept key gets its own. */
async function rig(options: RigOptions = {}): Promise<Rig> {
  if (options.keepKey === false) {
    const t = await testDb();
    own.push(t);
    return makeRig(t, { keys, ...options });
  }
  return makeRig(shared, { keys, ...options });
}

/** Taps start and then step until done, or `max` taps. Answers every reply. */
async function drive(r: Rig, max = 30): Promise<UpdateAnswer[]> {
  const answers = [await r.update.start()];
  while (answers.length < max && answers[answers.length - 1]!.body["done"] !== true && answers[answers.length - 1]!.status === 200) {
    answers.push(await r.update.step());
  }
  return answers;
}

const workerOf = (r: Rig) => r.fake.workers.get("vemi")!;
const bodies = (answers: UpdateAnswer[]): string => answers.map((a) => JSON.stringify(a.body)).join("\n");

describe("a good signed bundle", () => {
  it("ends with the new version deployed, migrations recorded once, and the secrets and cron kept", async () => {
    const r = await rig();
    const before = workerOf(r).versionId;
    const bookmark = r.fake.bookmarkOf([...r.fake.databases.values()][0]!);
    const answers = await drive(r);
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(answers[answers.length - 1]!.body).toMatchObject({ done: true, remaining: 0, progress: 1 });

    const worker = workerOf(r);
    expect(worker.metadata["tags"]).toEqual(["vemi:0.2.0"]);
    expect(worker.module).toContain("0.2.0");
    expect(worker.versionId).not.toBe(before);
    // Secrets and variables kept, cron and address kept, no migrations field sent.
    for (const name of ["DB", "LIVE", "ASSETS", "OWNER", "TIME_ZONE", "SETUP_FROM", "SETUP_CLAIM", "VAPID_PRIVATE"]) {
      expect(worker.bindings.map((b) => b.name)).toContain(name);
    }
    expect(worker.metadata["migrations"]).toBeUndefined();
    expect(worker.schedules).toEqual(["* * * * *"]);
    expect(worker.workersDev).toBe(true);

    const db = [...r.fake.databases.values()][0]!;
    expect(db.applied).toEqual(["0001_old.sql", "0034_more.sql", "0035_again.sql"]);
    expect(db.migrationSql).toHaveLength(2);
    expect(r.fake.servedAssets("vemi")).toHaveLength(5);

    const run = (await r.store.updateRun())!;
    expect(run).toMatchObject({ version: "0.2.0", step: "done", state: "done", migrated: 2, bookmark, newVersionId: worker.versionId });
    expect(run.previousVersionId).toBe(before);
    expect(run.backUntil).toBe(new Date(T0.getTime() + 7 * 86_400_000).toISOString());
  });

  it("does the migrations one a request and the files at most 20 a request, each tap under 40 requests", async () => {
    const release = await makeRelease(keys, "0.2.0", "Many files.", 45);
    const r = await rig({ release });
    const answers: UpdateAnswer[] = [];
    r.tap();
    answers.push(await r.update.start());
    let most = r.taps();
    let dataTaps = 0;
    while (answers[answers.length - 1]!.body["done"] !== true && answers.length < 40) {
      r.tap();
      const before = r.feedLog.length;
      const answer = await r.update.step();
      answers.push(answer);
      expect(answer.status).toBe(200);
      most = Math.max(most, r.taps());
      if (answer.body["step"] === "files") expect(r.feedLog.length - before).toBeLessThanOrEqual(20);
      if (answer.body["step"] === "data") dataTaps += 1;
    }
    expect(most).toBeLessThan(40);
    expect(dataTaps).toBe(2);
    expect(answers.filter((a) => a.body["step"] === "files")).toHaveLength(3);
    expect(r.fake.servedAssets("vemi")).toHaveLength(50);
    expect(answers.map((a) => a.body["remaining"])).toContain(30);
  });

  it("makes a second pass of every step change nothing", async () => {
    const r = await rig();
    await drive(r);
    const run = (await r.store.updateRun())!;
    const versions = r.fake.versions.get("vemi")!.length;
    const migrated = [...r.fake.databases.values()][0]!.applied.length;
    r.fake.clearRequests();
    for (const step of ["files", "data", "app"]) {
      await r.store.keepUpdateRun({ ...run, step, state: "running" });
      const answer = await r.update.step();
      expect(answer.status).toBe(200);
      expect(answer.body["step"]).toBe(step);
    }
    expect(r.fake.mutations()).toEqual([]);
    expect(r.fake.versions.get("vemi")!.length).toBe(versions);
    expect([...r.fake.databases.values()][0]!.applied).toHaveLength(migrated);
    expect(workerOf(r).metadata["tags"]).toEqual(["vemi:0.2.0"]);
    // And a tap after the run is done asks Cloudflare for nothing.
    await r.store.keepUpdateRun({ ...run, step: "done", state: "done" });
    r.fake.clearRequests();
    expect((await r.update.step()).body).toMatchObject({ done: true });
    expect(r.fake.count()).toBe(0);
  });

  it("starts again on the same release without a second run, and on a finished one without redoing it", async () => {
    const r = await rig();
    const first = await r.update.start();
    expect(first.status).toBe(200);
    r.fake.clearRequests();
    expect((await r.update.start()).status).toBe(200);
    expect(r.fake.count()).toBe(0);
    await drive(r);
    r.fake.clearRequests();
    expect((await r.update.start()).body).toMatchObject({ done: true });
    expect(r.fake.count()).toBe(0);
  });
});

describe("every call failing in turn", () => {
  // The label of the call to fail, and the step the run must name.
  const calls: [string, string][] = [
    ["accounts.list", "start"],
    ["worker.get", "start"],
    ["database.find", "start"],
    ["deployment.get", "start"],
    ["bookmark.get", "start"],
    ["assets.session", "files"],
    ["assets.upload", "files"],
    ["query", "data"],
    ["worker.upload", "app"],
    ["schedules.get", "app"],
  ];
  for (const [label, expected] of calls) {
    it(`names ${expected} when ${label} fails, and resumes to a finished update`, async () => {
      const r = await rig();
      r.fake.failOnce(label, 500, `broke with ${TOKEN}`);
      const failed: UpdateAnswer[] = [];
      let answer = await r.update.start();
      for (let n = 0; n < 40 && answer.body["done"] !== true; n++) {
        if (answer.status !== 200) {
          failed.push(answer);
          // After a failure, the run says it failed and which step; then the person taps again.
          const run = await r.store.updateRun();
          if (expected !== "start") expect(run).toMatchObject({ state: "failed", step: expected });
          answer = expected === "start" ? await r.update.start() : await r.update.step();
        } else {
          answer = await r.update.step();
        }
      }
      expect(failed).toHaveLength(1);
      expect(failed[0]!.body["step"]).toBe(expected);
      expect(String(failed[0]!.body["error"])).not.toContain(TOKEN);
      expect(answer.body).toMatchObject({ done: true });
      expect(workerOf(r).metadata["tags"]).toEqual(["vemi:0.2.0"]);
      expect([...r.fake.databases.values()][0]!.applied).toEqual(["0001_old.sql", "0034_more.sql", "0035_again.sql"]);
    });
  }

  it("stops at the migration whose write failed, names it, and resumes without recording it twice", async () => {
    const r = await rig();
    await r.update.start();
    await r.update.step();
    r.failNextMigration();
    const failed = await r.update.step();
    expect(failed.status).toBe(502);
    expect(failed.body["step"]).toBe("data");
    expect(String(failed.body["error"])).toContain("0034_more.sql");
    expect([...r.fake.databases.values()][0]!.applied).toEqual(["0001_old.sql"]);
    for (let n = 0; n < 5 && (await r.store.updateRun())!.step !== "done"; n++) await r.update.step();
    expect([...r.fake.databases.values()][0]!.applied).toEqual(["0001_old.sql", "0034_more.sql", "0035_again.sql"]);
  });
});

describe("what the deployed app holds afterwards", () => {
  it("fails the app step with a sentence naming the binding Cloudflare lost",async () => {
    const r = await rig();
    r.fake.dropBindingsOnUpload("SETUP_CLAIM");
    const answers = await drive(r);
    const failed = answers[answers.length - 1]!;
    expect(failed.status).toBe(502);
    expect(failed.body["step"]).toBe("app");
    expect(String(failed.body["error"])).toMatch(/SETUP_CLAIM.*\.$/);
    expect(await r.store.updateRun()).toMatchObject({ state: "failed", step: "app" });
  });

  it("reads the bindings after the upload, and a good run passes", async () => {
    const r = await rig();
    const answers = await drive(r);
    expect(answers[answers.length - 1]!.body).toMatchObject({ done: true });
    expect(r.fake.count("worker.get")).toBeGreaterThanOrEqual(3);
  });
});

describe("what is refused", () => {
  it("refuses a signature that does not hold, before anything reaches Cloudflare", async () => {
    const other = await makeKeys();
    const release = await makeRelease(other);
    const r = await rig({ release });
    const answer = await r.update.start();
    expect(answer.status).toBe(422);
    expect(answer.body["error"]).toBe(NOT_CHECKED);
    expect(r.fake.count()).toBe(0);
    expect((await r.store.updateRun())?.version).toBe("0.0.0");
  });

  it("refuses a step whose stored manifest was changed, and the Worker keeps running", async () => {
    const r = await rig();
    await r.update.start();
    const offer = (await r.store.updateCheck())!.offer!;
    await r.store.keepUpdateCheck({ ...offer, manifest: offer.manifest.replace("A calmer Today.", "A calmer Today!") });
    r.fake.clearRequests();
    const answer = await r.update.step();
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: NOT_CHECKED, step: "files" });
    expect(r.fake.count()).toBe(0);
    expect(workerOf(r).metadata["tags"]).toEqual(["vemi:0.1.0"]);
  });

  it("refuses a client file that differs from its signed hash and sends none", async () => {
    const r = await rig();
    await r.update.start();
    r.tamper("client/assets/app.js", new TextEncoder().encode(`console.log("0.9.9")`));
    const answer = await r.update.step();
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: NOT_CHECKED, step: "files" });
    expect(r.fake.count("assets.upload")).toBe(0);
    expect(r.fake.held.size).toBe(0);
    expect(workerOf(r).metadata["tags"]).toEqual(["vemi:0.1.0"]);
  });

  it("refuses a migration that differs from its signed hash and runs none", async () => {
    const r = await rig();
    await r.update.start();
    await r.update.step();
    r.tamper("migrations/0034_more.sql", new TextEncoder().encode("DROP TABLE account;"));
    const answer = await r.update.step();
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: NOT_CHECKED, step: "data" });
    expect(r.fake.mutations()).toEqual(expect.not.arrayContaining([expect.objectContaining({ label: "query.write" })]));
    expect([...r.fake.databases.values()][0]!.migrationSql).toEqual([]);
  });

  it("refuses a Worker that differs from its signed hash and uploads nothing", async () => {
    const r = await rig();
    await r.update.start();
    await r.update.step();
    await r.update.step();
    await r.update.step();
    expect((await r.store.updateRun())!.step).toBe("app");
    r.tamper("worker/index.js", new TextEncoder().encode(r.release.worker.bytes.length === 0 ? "" : "x".repeat(r.release.worker.bytes.length)));
    const answer = await r.update.step();
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: NOT_CHECKED, step: "app" });
    expect(r.fake.count("worker.upload")).toBe(0);
    expect(workerOf(r).metadata["tags"]).toEqual(["vemi:0.1.0"]);
  });

  it("refuses with a sentence when the offer is gone, not newer, or another run is open", async () => {
    const gone = await rig({ offer: false });
    expect(await gone.update.start()).toMatchObject({ status: 409, body: { error: "There is no update to install." } });

    const same = await rig({ running: "0.2.0" });
    expect(await same.update.start()).toMatchObject({ status: 409, body: { error: "That update is not newer than this copy." } });

    const busy = await rig();
    await busy.store.keepUpdateRun({
      version: "0.1.5", step: "data", state: "busy", accountId: "a", databaseId: "d", workerName: "vemi", previousVersionId: null, previousVersion: null,
      newVersionId: null, bookmark: null, migrated: 0, startedAt: T0.toISOString(), backUntil: null,
    });
    expect(await busy.update.start()).toMatchObject({ status: 409, body: { error: "Another update is already under way." } });
    expect(busy.fake.count()).toBe(0);
  });

  it("lets a newer release replace the offer in the middle of a run, with the first restore point kept", async () => {
    const r = await rig();
    // A run for an offer that is no longer the one held, stopped at a step, with its restore point from the first start.
    await r.store.keepUpdateRun({
      version: "0.1.5", step: "data", state: "failed", accountId: "a", databaseId: "d", workerName: "vemi", previousVersionId: "ver-first",
      previousVersion: "0.1.0", newVersionId: null, bookmark: "bookmark-first", migrated: 1, startedAt: T0.toISOString(), backUntil: null,
    });
    const stuck = await r.update.step();
    expect(stuck).toMatchObject({ status: 409, body: { error: "That update is no longer offered." } });

    const answers = await drive(r);
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(answers[answers.length - 1]!.body).toMatchObject({ done: true });
    expect(workerOf(r).metadata["tags"]).toEqual(["vemi:0.2.0"]);
    expect(await r.store.updateRun()).toMatchObject({
      version: "0.2.0", state: "done", previousVersionId: "ver-first", previousVersion: "0.1.0", bookmark: "bookmark-first",
    });
  });

  it("refuses when no sealed key exists, and when the address is not name.subdomain.workers.dev", async () => {
    const none = await rig({ keepKey: false });
    expect((await none.update.start()).status).toBe(409);
    await none.store.keepUpdateRun({
      version: "0.2.0", step: "files", state: "running", accountId: "a", databaseId: "d", workerName: "vemi", previousVersionId: null, previousVersion: null,
      newVersionId: null, bookmark: null, migrated: 0, startedAt: T0.toISOString(), backUntil: null,
    });
    expect((await none.update.step()).status).toBe(409);
    expect(none.fake.count()).toBe(0);

    const odd = await rig({ origin: "https://vemi.example.com" });
    const answer = await odd.update.start();
    expect(answer.status).toBe(409);
    expect(String(answer.body["error"])).toContain("address");
    expect(odd.fake.count()).toBe(0);
  });

});

describe("two taps at once", () => {
  it("make one run from start, and one piece of work from step", async () => {
    const r = await rig();
    const [a, b] = await Promise.all([r.update.start(), r.update.start()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await r.store.updateRun()).toMatchObject({ version: "0.2.0", step: "files", state: "running" });

    r.fake.clearRequests();
    const [c, d] = await Promise.all([r.update.step(), r.update.step()]);
    expect(c.status).toBe(200);
    expect(d.status).toBe(200);
    expect(r.fake.count("assets.session")).toBe(1);
    expect(r.fake.count("assets.upload")).toBe(3);

    await drive(r);
    for (let n = 0; n < 6 && (await r.store.updateRun())!.step !== "done"; n++) await Promise.all([r.update.step(), r.update.step()]);
    expect(r.fake.count("worker.upload")).toBe(1);
    expect(workerOf(r).metadata["tags"]).toEqual(["vemi:0.2.0"]);
  });
});

describe("the key", () => {
  it("is in no body and no console call, even when Cloudflare repeats it", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const r = await rig();
    r.fake.failOnce("worker.upload", 500, `Cloudflare said ${TOKEN}`);
    const answers = await drive(r, 40);
    const failed = answers[answers.length - 1]!;
    expect(failed.status).toBe(502);
    const more: UpdateAnswer[] = [];
    for (let n = 0; n < 20 && (await r.store.updateRun())!.step !== "done"; n++) more.push(await r.update.step());
    expect(bodies([...answers, ...more])).not.toContain(TOKEN);
    expect(bodies([...answers, ...more])).not.toContain("cf-token");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(await r.store.updateRun())).not.toContain(TOKEN);
    expect(r.fake.log.join("\n")).not.toContain(TOKEN);
  });

  it("is read inside a step only: the run row and the update object hold no key", async () => {
    const r = await rig();
    await drive(r);
    expect(JSON.stringify(await r.store.updateRun())).not.toContain(TOKEN);
    expect(JSON.stringify(r.update)).not.toContain(TOKEN);
    expect(ORIGIN).toContain("workers.dev");
  });
});

describe("going back", () => {
  const DAY = 86_400_000;
  /** A rig whose clock the test moves. */
  async function clocked(options: RigOptions = {}): Promise<{ r: Rig; at: { now: Date } }> {
    const at = { now: new Date(T0) };
    return { r: await rig({ ...options, now: () => at.now }), at };
  }

  it("deploys the version the copy ran before, records it, and leaves the data as the update left it", async () => {
    const { r } = await clocked();
    const before = workerOf(r).versionId;
    await drive(r);
    const after = workerOf(r).versionId;
    expect(after).not.toBe(before);
    const applied = [...[...r.fake.databases.values()][0]!.applied];

    const answer = await r.update.back();
    expect(answer).toEqual({ status: 200, body: { back: true, version: "0.1.0" } });
    expect(workerOf(r).versionId).toBe(before);
    expect([...r.fake.databases.values()][0]!.applied).toEqual(applied);
    expect(await r.store.updateRun()).toMatchObject({ version: "0.2.0", state: "back", previousVersion: "0.1.0", previousVersionId: before });
  });

  it("refuses after seven days with a sentence, and calls Cloudflare for nothing", async () => {
    const { r, at } = await clocked();
    await drive(r);
    at.now = new Date(T0.getTime() + 7 * DAY + 1000);
    r.fake.clearRequests();
    const answer = await r.update.back();
    expect(answer.status).toBe(409);
    expect(String(answer.body["error"])).toMatch(/seven days.*\.$/);
    expect(r.fake.count()).toBe(0);
    expect(await r.store.updateRun()).toMatchObject({ state: "done" });
  });

  it("goes back inside the seven days, on the last day", async () => {
    const { r, at } = await clocked();
    await drive(r);
    at.now = new Date(T0.getTime() + 7 * DAY - 1000);
    expect((await r.update.back()).status).toBe(200);
  });

  it("goes back once: the second tap is refused and deploys nothing", async () => {
    const { r } = await clocked();
    await drive(r);
    expect((await r.update.back()).status).toBe(200);
    r.fake.clearRequests();
    const again = await r.update.back();
    expect(again.status).toBe(409);
    expect(String(again.body["error"])).toMatch(/already gone back.*\.$/);
    expect(r.fake.count()).toBe(0);
  });

  it("refuses with a sentence when no previous version was kept, or no update has run", async () => {
    const { r } = await clocked();
    const none = await r.update.back();
    expect(none.status).toBe(409);
    expect(String(none.body["error"])).toMatch(/\.$/);
    await drive(r);
    const run = (await r.store.updateRun())!;
    await r.store.keepUpdateRun({ ...run, previousVersionId: null });
    const answer = await r.update.back();
    expect(answer.status).toBe(409);
    expect(String(answer.body["error"])).toMatch(/earlier version.*\.$/);
  });

  it("holds the run as it was when Cloudflare refuses, so the person can try again", async () => {
    const { r } = await clocked();
    await drive(r);
    r.fake.failOnce("deployment.create", 500, "internal error");
    const failed = await r.update.back();
    expect(failed.status).toBe(502);
    expect(await r.store.updateRun()).toMatchObject({ state: "done" });
    expect((await r.update.back()).status).toBe(200);
  });

  it("goes back with force, and says so, when Cloudflare names a secret that changed since the version was made", async () => {
    const { r } = await clocked();
    const before = workerOf(r).versionId;
    await drive(r);
    r.fake.failOnce("deployment.create", 400, "Secrets have changed since this version was created. Use force to deploy it anyway.");
    const answer = await r.update.back();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ back: true, version: "0.1.0", forced: true });
    expect(String(answer.body["said"])).toMatch(/secret.*\.$/i);
    expect(workerOf(r).versionId).toBe(before);
    expect(r.fake.count("deployment.create")).toBe(2);
    expect(r.fake.deployments.get("vemi")![0]!.forced).toBe(true);
    expect(await r.store.updateRun()).toMatchObject({ state: "back" });
  });

  it("does not force for any other refusal", async () => {
    const { r } = await clocked();
    await drive(r);
    r.fake.failOnce("deployment.create", 400, "That version cannot be deployed.");
    const failed = await r.update.back();
    expect(failed.status).toBe(502);
    expect(r.fake.count("deployment.create")).toBe(1);
    expect(await r.store.updateRun()).toMatchObject({ state: "done" });
  });

  it("offers the release again afterwards, and updating again installs it once more without redoing the data", async () => {
    const { r } = await clocked();
    await drive(r);
    await r.update.back();
    expect((await r.store.updateCheck())!.checkedAt < "2000").toBe(true);
    expect((await r.store.updateCheck())!.offer).not.toBeNull();

    const db = [...r.fake.databases.values()][0]!;
    const migrations = db.migrationSql.length;
    const again = await drive(r);
    expect(again.every((a) => a.status === 200)).toBe(true);
    expect(again[again.length - 1]!.body).toMatchObject({ done: true });
    expect(workerOf(r).metadata["tags"]).toEqual(["vemi:0.2.0"]);
    expect(db.migrationSql).toHaveLength(migrations);
    expect(await r.store.updateRun()).toMatchObject({ state: "done", version: "0.2.0" });
  });

  it("puts no key in a body or a console call", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const { r } = await clocked();
    await drive(r);
    r.fake.failOnce("deployment.create", 500, `Cloudflare said ${TOKEN}`);
    const failed = await r.update.back();
    expect(JSON.stringify(failed.body)).not.toContain(TOKEN);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("turning Update myself off", () => {
  it("deletes the sealed key, says so, and no step runs afterwards", async () => {
    const r = await rig();
    expect((await r.store.setupClaim())!.sealedToken).not.toBeNull();
    const answer = await r.update.off();
    expect(answer).toEqual({ status: 200, body: { off: true, said: "Key removed from this copy. Remove it in Cloudflare too." } });
    // The row stays, spent: only the key and the wish to keep updated go.
    expect(await r.store.setupClaim()).toMatchObject({ sealedToken: null, keepUpdated: false });

    r.fake.clearRequests();
    for (const run of [await r.update.start(), await r.update.back()]) expect(run.status).toBe(409);
    await r.update.step();
    expect(r.fake.count()).toBe(0);

    // A run left open when the key went cannot carry on: its step is refused, not run.
    const run = (await r.store.updateRun())!;
    await r.store.keepUpdateRun({ ...run, step: "files", state: "running" });
    const stopped = await r.update.step();
    expect(stopped.status).toBe(409);
    expect(r.fake.count()).toBe(0);
  });

  it("is refused a second time with a sentence, and the copy has no way to turn it on", async () => {
    const r = await rig();
    await r.update.off();
    const twice = await r.update.off();
    expect(twice.status).toBe(409);
    expect(String(twice.body["error"])).toMatch(/\.$/);
    expect(Object.keys(r.update).sort()).toEqual(["back", "off", "start", "step"]);
  });

  it("answers 409 for a copy that kept no key", async () => {
    const r = await rig({ keepKey: false });
    expect((await r.update.off()).status).toBe(409);
  });
});
