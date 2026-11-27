import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VERSION } from "@vemi/shared";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { sessionKey } from "./sessionKey.js";
import { createSetup } from "./setup.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { createUpdateCheckJob } from "./updateCheck.js";

/**
 * The daily check for a newer release, against a fake feed signed in memory, and the one route
 * that reports what it found.
 */

const FEED = "https://feed.example.org/release/";
const T0 = new Date("2026-12-01T11:00:00.000Z");
const hours = (n: number): Date => new Date(T0.getTime() + n * 3_600_000);

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

interface Bundle { latest: string; manifest: string; signature: string; version: string }

let publicKey = "";
let privateKey: CryptoKey;
let t: TestDb;

beforeAll(async () => {
  t = await testDb();
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer));
});
afterAll(() => t.dispose());

async function bundle(version: string, notes = "Fixes and small things.", issuedAt = "2026-11-30T00:00:00.000Z"): Promise<Bundle> {
  const manifest = `${JSON.stringify({ format: 1, version, issuedAt, notes }, null, 2)}\n`;
  const bytes = new TextEncoder().encode(manifest);
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, bytes as BufferSource)));
  const sha = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
  return { latest: JSON.stringify({ version, manifestSha256: sha }), manifest, signature, version };
}

interface Seen { url: string; init: RequestInit | undefined }

/** A fake feed: serves the bundle by path, answering `status` for everything when set. */
function feed(served: Bundle | null, options: { status?: number; manifest?: string; padding?: number } = {}) {
  const seen: Seen[] = [];
  const fetchFake = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, init });
    if (options.status !== undefined) return new Response("nope", { status: options.status });
    if (served === null) throw new Error("feed down");
    if (url === `${FEED}latest.json`) return new Response(served.latest);
    if (url === `${FEED}${served.version}/manifest.json`) {
      return new Response(options.manifest ?? served.manifest + " ".repeat(options.padding ?? 0));
    }
    if (url === `${FEED}${served.version}/manifest.sig`) return new Response(served.signature);
    return new Response("missing", { status: 404 });
  };
  return { seen, fetch: fetchFake };
}

function job(fake: { fetch: (url: string, init: RequestInit) => Promise<Response> }, options: { feed?: string; version?: string } = {}) {
  return createUpdateCheckJob({
    feed: options.feed ?? FEED, publicKey, version: options.version ?? "0.1.0", fetch: fake.fetch,
  });
}

/** A fresh database per case. */
async function fresh() {
  const db = await testDb();
  return { env: { DB: db.db }, store: openStore({ DB: db.db }), dispose: () => db.dispose() };
}

describe("the daily check", () => {
  it("keeps a good, newer, signed release as the offer", async () => {
    const c = await fresh();
    try {
      const good = await bundle("0.2.0");
      const fake = feed(good);
      await job(fake).run(T0, c.env);
      const kept = await openStore(c.env).updateCheck();
      expect(kept?.offer).toEqual({ version: "0.2.0", manifest: good.manifest, signature: good.signature });
      expect(fake.seen.map((s) => s.url)).toEqual([`${FEED}latest.json`, `${FEED}0.2.0/manifest.json`, `${FEED}0.2.0/manifest.sig`]);
    } finally {
      await c.dispose();
    }
  });

  it("remembers the signed issue date, and takes the same date again", async () => {
    const c = await fresh();
    try {
      await job(feed(await bundle("0.2.0"))).run(T0, c.env);
      expect((await openStore(c.env).updateCheck())?.issuedAt).toBe("2026-11-30T00:00:00.000Z");
      await job(feed(await bundle("0.2.0"))).run(hours(30), c.env);
      expect((await openStore(c.env).updateCheck())?.offer?.version).toBe("0.2.0");
    } finally {
      await c.dispose();
    }
  });

  it("refuses a replayed older feed once a newer date was accepted, and keeps the offer and the date", async () => {
    const c = await fresh();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await job(feed(await bundle("0.2.0", "New.", "2026-11-30T00:00:00.000Z"))).run(T0, c.env);
      // An old, validly signed feed played back: it is older than what was accepted.
      const replay = await bundle("0.1.5", "Old.", "2026-11-01T00:00:00.000Z");
      await job(feed(replay)).run(hours(30), c.env);
      const kept = await openStore(c.env).updateCheck();
      expect(kept?.offer?.version).toBe("0.2.0");
      expect(kept?.issuedAt).toBe("2026-11-30T00:00:00.000Z");
      expect(spy).toHaveBeenCalledWith("update check failed: the release is older than one already accepted");
    } finally {
      spy.mockRestore();
      await c.dispose();
    }
  });

  it("accepts a later date and raises the kept one", async () => {
    const c = await fresh();
    try {
      await job(feed(await bundle("0.2.0", "New.", "2026-11-30T00:00:00.000Z"))).run(T0, c.env);
      await job(feed(await bundle("0.3.0", "Newer.", "2026-12-01T01:00:00.000Z"))).run(hours(30), c.env);
      const kept = await openStore(c.env).updateCheck();
      expect(kept?.offer?.version).toBe("0.3.0");
      expect(kept?.issuedAt).toBe("2026-12-01T01:00:00.000Z");
    } finally {
      await c.dispose();
    }
  });

  it("refuses a date more than a day ahead of the clock, and takes one just inside", async () => {
    const c = await fresh();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await job(feed(await bundle("0.2.0", "Far.", "2026-12-02T11:00:00.001Z"))).run(T0, c.env);
      expect(await openStore(c.env).updateCheck()).toBeNull();
      expect(spy).toHaveBeenCalledWith("update check failed: the release is dated in the future");
      await job(feed(await bundle("0.2.0", "Near.", "2026-12-02T11:00:00.000Z"))).run(T0, c.env);
      expect((await openStore(c.env).updateCheck())?.offer?.version).toBe("0.2.0");
    } finally {
      spy.mockRestore();
      await c.dispose();
    }
  });

  it("refuses a signed manifest with no issue date", async () => {
    const c = await fresh();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const manifest = `${JSON.stringify({ format: 1, version: "0.2.0", notes: "x" }, null, 2)}\n`;
      const bytes = new TextEncoder().encode(manifest);
      const signature = b64url(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, bytes as BufferSource)));
      const sha = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
      await job(feed({ latest: JSON.stringify({ version: "0.2.0", manifestSha256: sha }), manifest, signature, version: "0.2.0" })).run(T0, c.env);
      expect(await openStore(c.env).updateCheck()).toBeNull();
    } finally {
      spy.mockRestore();
      await c.dispose();
    }
  });

  it("asks with plain GETs: no cookie, no query, no identifying header", async () => {
    const c = await fresh();
    try {
      const fake = feed(await bundle("0.2.0"));
      await job(fake).run(T0, c.env);
      for (const s of fake.seen) {
        expect(new URL(s.url).search).toBe("");
        expect(s.init?.method).toBe("GET");
        expect(s.init?.headers).toBeUndefined();
        expect(s.init?.body).toBeUndefined();
        // A feed that never answers must not hold the job: every ask carries a time limit.
        expect(s.init?.signal).toBeInstanceOf(AbortSignal);
      }
    } finally {
      await c.dispose();
    }
  });

  it("keeps the old offer and logs one line without the body when the manifest was tampered with", async () => {
    const c = await fresh();
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    try {
      const old = await bundle("0.2.0");
      await job(feed(old)).run(T0, c.env);
      const good = await bundle("0.3.0");
      const changed = good.manifest.replace("Fixes", "Evil");
      // The hash in latest.json is of the changed text, so only the signature can catch it.
      const sha = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(changed))));
      const tampered: Bundle = { ...good, latest: JSON.stringify({ version: "0.3.0", manifestSha256: sha }) };
      await expect(job(feed(tampered, { manifest: changed })).run(hours(30), c.env)).resolves.toBeUndefined();
      expect((await openStore(c.env).updateCheck())?.offer?.version).toBe("0.2.0");
      expect(logged).toHaveLength(1);
      expect(logged[0]).not.toContain("Evil");
    } finally {
      spy.mockRestore();
      await c.dispose();
    }
  });

  it("keeps the old offer when the manifest does not match latest.json", async () => {
    const c = await fresh();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await job(feed(await bundle("0.2.0"))).run(T0, c.env);
      const good = await bundle("0.3.0");
      await job(feed(good, { manifest: `${good.manifest} ` })).run(hours(30), c.env);
      expect((await openStore(c.env).updateCheck())?.offer?.version).toBe("0.2.0");
    } finally {
      spy.mockRestore();
      await c.dispose();
    }
  });

  it("clears the offer when the signed release is not newer than the running copy", async () => {
    const c = await fresh();
    try {
      await job(feed(await bundle("0.2.0"))).run(T0, c.env);
      expect((await openStore(c.env).updateCheck())?.offer).not.toBeNull();
      await job(feed(await bundle("0.1.0"))).run(hours(30), c.env);
      const after = await openStore(c.env).updateCheck();
      expect(after?.offer).toBeNull();
      expect(after?.checkedAt).toBe(hours(30).toISOString());
      await job(feed(await bundle("0.2.0"))).run(hours(60), c.env);
      expect((await openStore(c.env).updateCheck())?.offer?.version).toBe("0.2.0");
    } finally {
      await c.dispose();
    }
  });

  it("keeps the old offer, and never throws, when the feed is down or answers a non-200", async () => {
    const c = await fresh();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await job(feed(await bundle("0.2.0"))).run(T0, c.env);
      await expect(job(feed(null)).run(hours(30), c.env)).resolves.toBeUndefined();
      await expect(job(feed(await bundle("0.3.0"), { status: 503 })).run(hours(31), c.env)).resolves.toBeUndefined();
      expect((await openStore(c.env).updateCheck())?.offer?.version).toBe("0.2.0");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      await c.dispose();
    }
  });

  it("keeps the old offer when a body is over 256 KB", async () => {
    const c = await fresh();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await job(feed(await bundle("0.2.0"))).run(T0, c.env);
      await job(feed(await bundle("0.3.0"), { padding: 300 * 1024 })).run(hours(30), c.env);
      expect((await openStore(c.env).updateCheck())?.offer?.version).toBe("0.2.0");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      await c.dispose();
    }
  });

  it("makes no request on a second run inside 23 hours, and checks again after", async () => {
    const c = await fresh();
    try {
      const fake = feed(await bundle("0.2.0"));
      await job(fake).run(T0, c.env);
      const first = fake.seen.length;
      await job(fake).run(hours(1), c.env);
      await job(fake).run(hours(22), c.env);
      expect(fake.seen).toHaveLength(first);
      await job(fake).run(hours(23), c.env);
      expect(fake.seen.length).toBeGreaterThan(first);
    } finally {
      await c.dispose();
    }
  });

  it("makes no request at all while the feed is empty", async () => {
    const c = await fresh();
    try {
      const fake = feed(await bundle("0.2.0"));
      await job(fake, { feed: "" }).run(T0, c.env);
      expect(fake.seen).toHaveLength(0);
      expect(await openStore(c.env).updateCheck()).toBeNull();
    } finally {
      await c.dispose();
    }
  });

  it("fails closed with a clear line, and makes no request, when the copy has no release key", async () => {
    const c = await fresh();
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    try {
      const fake = feed(await bundle("0.2.0"));
      await createUpdateCheckJob({ feed: FEED, publicKey: "", version: "0.1.0", fetch: fake.fetch }).run(T0, c.env);
      expect(fake.seen).toHaveLength(0);
      expect((await openStore(c.env).updateCheck())?.offer ?? null).toBeNull();
      expect(logged).toEqual(["update check skipped: this copy has no release key"]);
    } finally {
      spy.mockRestore();
      await c.dispose();
    }
  });

  it("runs hourly at minute 11", () => {
    expect(job(feed(null)).schedule).toBe("11 * * * *");
  });
});

describe("the store's update run", () => {
  it("keeps and reads the one run, and replaces it", async () => {
    const c = await fresh();
    try {
      expect(await c.store.updateRun()).toBeNull();
      const run = {
        version: "0.2.0", step: "assets", state: "running", accountId: "acct", databaseId: "db", workerName: "vemi",
        previousVersionId: "prev", previousVersion: null, newVersionId: null, bookmark: "bm", migrated: 2, startedAt: T0.toISOString(), backUntil: null,
      };
      const kept = await c.store.keepUpdateRun(run);
      expect(await c.store.updateRun()).toEqual(kept);
      await c.store.keepUpdateRun({ ...run, step: "done", state: "done", migrated: 3 });
      expect(await c.store.updateRun()).toMatchObject({ step: "done", migrated: 3 });
    } finally {
      await c.dispose();
    }
  });
});

const ORIGIN = "https://vemi.example.workers.dev";
const CODE = "a-setup-code-only-the-page-knows";
const TOKEN = "cf-token-value-for-tests-0123456789";

async function copy(claimed: boolean) {
  const db = await testDb();
  const store = openStore({ DB: db.db });
  const identity = accountIdentity({
    store, now: () => new Date(), origin: ORIGIN, owner: "owner", operatorEmail: "",
    sessionSecret: () => sessionKey(store), google: null, setupClaim: true,
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: () => new Date(), origin: ORIGIN, timeZone: "UTC", copyOwner: "owner",
    setup: createSetup({ store, secret: CODE, from: "https://setup.example.org", origin: ORIGIN }),
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    app(new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, "cf-connecting-ip": "10.1.1.1", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), () => {});
  await call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: claimed });
  const signed = await call("POST", "/auth/claim", { email: "me@example.com", password: "correct horse battery" });
  const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { store, call, cookie, dispose: () => db.dispose() };
}

describe("GET /api/update", () => {
  it("answers current, the offer with its notes, and whether the owner can update", async () => {
    const c = await copy(true);
    try {
      expect((await c.call("GET", "/api/update")).status).toBe(401);
      expect(await (await c.call("GET", "/api/update", undefined, { cookie: c.cookie })).json()).toEqual({
        current: VERSION, offer: null, canUpdate: true, auto: true, back: false, goBack: null, backed: null, keyKept: true,
      });
      // Newer than whatever this code is, so it is offered whatever VERSION says.
      const good = await bundle("99.0.0", "A calmer Today.");
      await c.store.keepUpdateCheck({ version: "99.0.0", manifest: good.manifest, signature: good.signature });
      const res = await c.call("GET", "/api/update", undefined, { cookie: c.cookie });
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ offer: { version: "99.0.0", notes: "A calmer Today." } });
      expect(text).not.toContain(good.signature);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("feed.example.org");
    } finally {
      await c.dispose();
    }
  });

  it("offers nothing when the stored offer is the running version or older", async () => {
    const c = await copy(true);
    try {
      for (const version of ["0.1.0", "0.0.9"]) {
        const old = await bundle(version, "Already here.");
        await c.store.keepUpdateCheck({ version, manifest: old.manifest, signature: old.signature });
        const body = (await (await c.call("GET", "/api/update", undefined, { cookie: c.cookie })).json()) as { offer: unknown };
        expect(body.offer).toBeNull();
      }
    } finally {
      await c.dispose();
    }
  });

  it("says canUpdate is false when no key was kept, and keeps both tables out of the export", async () => {
    const c = await copy(false);
    try {
      const body = (await (await c.call("GET", "/api/update", undefined, { cookie: c.cookie })).json()) as { canUpdate: boolean; auto: boolean };
      expect(body).toMatchObject({ canUpdate: false, auto: false });
      const good = await bundle("0.2.0");
      await c.store.keepUpdateCheck({ version: "0.2.0", manifest: good.manifest, signature: good.signature });
      const doc = JSON.parse(await (await c.call("GET", "/api/export", undefined, { cookie: c.cookie })).text()) as { tables: Record<string, unknown[]> };
      expect(doc.tables["update_offer"] ?? []).toEqual([]);
      expect(doc.tables["update_run"] ?? []).toEqual([]);
    } finally {
      await c.dispose();
    }
  });
});
