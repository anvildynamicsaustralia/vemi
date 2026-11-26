import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { sessionKey } from "./sessionKey.js";
import { createSetup } from "./setup.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { CODE, ORIGIN, TOKEN, makeKeys, makeRig, type Keys, type Rig } from "./testing/updateRig.js";
import { updateRoute } from "./updateRoutes.js";

/** The two update writes through the real app: who may call them, and what they answer. */

let keys: Keys;
let t: TestDb;
let rig: Rig;
let cookie = "";
let owner: ReturnType<typeof createApp>;
let stranger: ReturnType<typeof createApp>;
let bare: ReturnType<typeof createApp>;

function appFor(copyOwner: string, withUpdate: boolean) {
  const identity = accountIdentity({
    store: rig.store, now: () => new Date(), origin: ORIGIN, owner: "owner", operatorEmail: "",
    sessionSecret: () => sessionKey(rig.store), google: null, setupClaim: true,
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  return createApp({
    store: rig.store, identity, now: () => new Date(), origin: ORIGIN, timeZone: "UTC", copyOwner,
    setup: createSetup({ store: rig.store, secret: CODE, from: "https://setup.example.org", origin: ORIGIN }),
    ...(withUpdate ? { update: rig.update } : {}),
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
}

const send = (app: ReturnType<typeof createApp>, method: string, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  app(new Request(`${ORIGIN}${path}`, { method, headers: { "cf-connecting-ip": "10.1.1.1", ...headers } }), () => {});
const post = (app: ReturnType<typeof createApp>, path: string, extra: Record<string, string> = {}): Promise<Response> =>
  send(app, "POST", path, { origin: ORIGIN, cookie, ...extra });

beforeAll(async () => {
  keys = await makeKeys();
  t = await testDb();
  rig = await makeRig(t, { keys });
  owner = appFor("owner", true);
  stranger = appFor("someone-else", true);
  bare = appFor("owner", false);
  const signed = await owner(new Request(`${ORIGIN}/auth/claim`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "10.1.1.1" },
    body: JSON.stringify({ email: "me@example.com", password: "correct horse battery" }),
  }), () => {});
  cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});
afterAll(() => t.dispose());

describe("POST /api/update/start and /step", () => {
  it("needs a session and the copy's own Origin", async () => {
    expect((await send(owner, "POST", "/api/update/start", { origin: ORIGIN })).status).toBe(401);
    expect((await send(owner, "POST", "/api/update/start", { cookie })).status).toBe(403);
    expect((await send(owner, "POST", "/api/update/start", { cookie, origin: "https://elsewhere.example.org" })).status).toBe(403);
    expect(rig.fake.count()).toBe(0);
  });

  it("answers 403 to anyone but the owner, and reads nothing from Cloudflare", async () => {
    for (const path of ["/api/update/start", "/api/update/step"]) {
      const res = await post(stranger, path);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Only the owner can do this." });
    }
    expect(rig.fake.count()).toBe(0);
  });

  it("answers 409 with a sentence when the copy has no way to update itself", async () => {
    const res = await post(bare, "/api/update/start");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/\.$/);
  });

  it("refuses a GET and any other action", async () => {
    expect((await send(owner, "GET", "/api/update/start", { cookie })).status).toBe(405);
    expect((await post(owner, "/api/update/other")).status).toBe(404);
  });

  it("starts, steps to done, and answers the shape {step, done, remaining, progress}", async () => {
    const started = await post(owner, "/api/update/start");
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ step: "start", done: false, remaining: 5, progress: 0 });
    const seen: string[] = [];
    let last: Record<string, unknown> = {};
    for (let n = 0; n < 12 && last["done"] !== true; n++) {
      const res = await post(owner, "/api/update/step");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(TOKEN);
      last = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(last).sort()).toEqual(["done", "progress", "remaining", "step"]);
      seen.push(String(last["step"]));
    }
    expect(last).toEqual({ step: "app", done: true, remaining: 0, progress: 1 });
    expect(seen).toContain("files");
    expect(seen).toContain("data");
    const summary = await (await send(owner, "GET", "/api/update", { cookie })).json();
    expect(summary).toMatchObject({ current: "0.1.0", back: true });
  });
});

describe("POST /api/update/back and /off", () => {
  const get = async (app: ReturnType<typeof createApp>): Promise<Record<string, unknown>> =>
    (await (await send(app, "GET", "/api/update", { cookie })).json()) as Record<string, unknown>;
  const asJson = { "content-type": "application/json" };

  it("tells the owner what Go back returns to, until when, and the restore point only when data changed", async () => {
    const run = (await rig.store.updateRun())!;
    expect(run.state).toBe("done");
    const seen = await get(owner);
    expect(seen["goBack"]).toEqual({ version: "0.1.0", until: run.backUntil, restorePoint: run.bookmark });
    expect(run.bookmark).not.toBeNull();
    expect(seen).toMatchObject({ keyKept: true, backed: null });

    await rig.store.keepUpdateRun({ ...run, migrated: 0 });
    expect((await get(owner))["goBack"]).toEqual({ version: "0.1.0", until: run.backUntil, restorePoint: null });
    await rig.store.keepUpdateRun(run);

    // Nobody but the owner is told.
    expect(await get(stranger)).toMatchObject({ goBack: null, backed: null, keyKept: false });
  });

  it("holds Go back to the owner and to the copy's own Origin, and calls Cloudflare for neither refusal", async () => {
    rig.fake.clearRequests();
    expect((await send(owner, "POST", "/api/update/back", { cookie })).status).toBe(403);
    expect((await post(stranger, "/api/update/back")).status).toBe(403);
    expect((await send(owner, "POST", "/api/update/back", { origin: ORIGIN })).status).toBe(401);
    expect((await send(owner, "GET", "/api/update/back", { cookie })).status).toBe(405);
    expect(rig.fake.count()).toBe(0);
    expect((await post(bare, "/api/update/back")).status).toBe(409);
  });

  it("goes back once, shows Back on the old version, and refuses a second time with a sentence", async () => {
    const before = (await rig.store.updateRun())!.previousVersionId;
    const res = await post(owner, "/api/update/back");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ back: true, version: "0.1.0" });
    expect(rig.fake.workers.get("vemi")!.versionId).toBe(before);

    const seen = await get(owner);
    expect(seen).toMatchObject({ back: false, goBack: null, backed: "0.1.0" });

    const again = await post(owner, "/api/update/back");
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/\.$/);
  });

  it("turns Off only for the owner, only with the word off typed, and then says what is left to do", async () => {
    rig.fake.clearRequests();
    expect((await post(stranger, "/api/update/off", asJson)).status).toBe(403);
    expect((await send(owner, "POST", "/api/update/off", { cookie, ...asJson })).status).toBe(403);
    const raw = (body: string) => owner(new Request(`${ORIGIN}/api/update/off`, {
      method: "POST", headers: { origin: ORIGIN, cookie, "cf-connecting-ip": "10.1.1.1", ...asJson }, body,
    }), () => {});
    for (const body of ["{}", '{"confirm":"yes"}', '{"confirm":"off","more":1}', "[]", "nope"]) expect((await raw(body)).status).toBe(400);
    expect((await rig.store.setupClaim())!.sealedToken).not.toBeNull();

    const typed = (confirm: string) => raw(JSON.stringify({ confirm }));
    expect((await typed("Off")).status).toBe(400);
    expect((await rig.store.setupClaim())!.sealedToken).not.toBeNull();

    const res = await typed("off");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ off: true, said: "Key removed from this copy. Remove it in Cloudflare too." });
    expect(await rig.store.setupClaim()).toMatchObject({ keepUpdated: false, sealedToken: null });
    expect(rig.fake.count()).toBe(0);

    expect(await get(owner)).toMatchObject({ canUpdate: false, keyKept: false });
    expect((await post(owner, "/api/update/start")).status).toBe(409);
    expect((await typed("off")).status).toBe(409);
  });
});

describe("updateRoute", () => {
  it("answers null for a path that is not its own, and 405 for a read", async () => {
    expect(await updateRoute({ copyOwner: "owner" }, "owner", "POST", "other")).toBeNull();
    expect(await updateRoute({ copyOwner: "owner" }, "owner", "GET", "step")).toMatchObject({ status: 405 });
    expect(await updateRoute({ copyOwner: "", update: undefined }, "", "POST", "start")).toMatchObject({ status: 403 });
  });
});
