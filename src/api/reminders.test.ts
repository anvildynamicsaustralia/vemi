import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "@vemi/shared";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { migrationStatements, testDb, type TestDb } from "./testing/d1.js";
import { parseAppearance, parsePushSubscription } from "./validate.js";
import { fromBase64Url, importVapidSigningKey, makeVapidKey, vapidKeys } from "./vapid.js";
import { PROFILE_DEFAULTS } from "./testing/profileDefaults.js";

/**
 * 0020_reminders: the tables a device's push subscription and the sent record live in, the
 * key pair this copy signs with, and four settings on the account. Every assertion maps to a
 * line of the task's Done: the account columns arrive off, the settings ride the appearance
 * routes strictly, the four push routes work and are owner-scoped, the key pair is made once
 * and kept unless both secrets are set, and a second account never sees the first's rows.
 */

type Row = Record<string, unknown>;
const T = "2026-01-01T00:00:00.000Z";
const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-18T02:00:00Z");
const P256DH = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const AUTH = "tBHItJI5svbpez7KI4CCXg";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

describe("0020_reminders over a database holding 0001 to 0019", () => {
  let old: TestDb;
  const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
  const all = async (sql: string): Promise<Row[]> => (await old.db.prepare(sql).all<Row>()).results;
  const apply = async (again: boolean) => {
    for (const sql of migrationStatements((f) => f.startsWith("0020_"))) {
      try {
        await old.db.prepare(sql).run();
      } catch (e) {
        // The runner never applies a file twice. SQLite has no ADD COLUMN IF NOT EXISTS, and
        // the tables are created plainly, so a second pass may refuse only on what exists.
        const said = e instanceof Error ? e.message : "";
        if (!(again && (said.includes("duplicate column name") || said.includes("already exists")))) throw e;
      }
    }
  };

  beforeAll(async () => {
    old = await testDb({ through: "0019_capture_settings.sql" });
    await go(`INSERT INTO tenant (id, created_at) VALUES ('o', ?)`, T);
    await go(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('o', 'o@example.test', 'x', ?, ?)`, T, T);
    await apply(false);
  });
  afterAll(() => old.dispose());

  it("adds the four account columns, all off, to an existing account", async () => {
    expect((await all(`SELECT remind_morning, remind_tasks, quiet_from, quiet_to FROM account`))[0])
      .toEqual({ remind_morning: null, remind_tasks: 0, quiet_from: null, quiet_to: null });
  });

  it("makes the three tables", async () => {
    const columns = async (table: string) => (await all(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name);
    expect(await columns("push_subscription")).toEqual(
      expect.arrayContaining(["id", "owner", "endpoint", "p256dh", "auth", "label", "tz", "created_at", "last_ok_at"]),
    );
    expect(await columns("reminder_sent")).toEqual(expect.arrayContaining(["owner", "kind", "ref", "at"]));
    expect(await columns("vapid_key")).toEqual(expect.arrayContaining(["public_key", "private_key"]));
  });

  it("holds one endpoint once, one sent record once, and one key row", async () => {
    const sub = (id: string, endpoint: string) => go(
      `INSERT INTO push_subscription (id, owner, endpoint, p256dh, auth, tz, created_at) VALUES (?, 'o', ?, 'k', 'a', 'UTC', ?)`, id, endpoint, T,
    );
    await sub("s1", "https://x.test/1");
    await expect(sub("s2", "https://x.test/1")).rejects.toThrow();
    const sent = () => go(`INSERT INTO reminder_sent (owner, kind, ref, at) VALUES ('o', 'task', 't1', '2026-11-18T09:00')`);
    await sent();
    await expect(sent()).rejects.toThrow();
    await go(`INSERT INTO vapid_key (id, public_key, private_key, created_at) VALUES (1, 'p', 'q', ?)`, T);
    await expect(go(`INSERT INTO vapid_key (id, public_key, private_key, created_at) VALUES (2, 'p', 'q', ?)`, T)).rejects.toThrow();
  });

  it("changes nothing when the file is applied a second time", async () => {
    await go(`UPDATE account SET remind_morning = '06:30', remind_tasks = 1, quiet_from = '21:00', quiet_to = '07:00'`);
    const before = [await all(`SELECT * FROM account`), await all(`SELECT * FROM push_subscription`), await all(`SELECT * FROM vapid_key`)];
    await apply(true);
    expect([await all(`SELECT * FROM account`), await all(`SELECT * FROM push_subscription`), await all(`SELECT * FROM vapid_key`)]).toEqual(before);
  });
});

describe("reminder settings and push subscriptions through the store and the routes", () => {
  let t: TestDb;
  let store: Store;
  let app: App;
  let passwordHash: string;
  const EMPTY = {
    ...DEFAULT_APPEARANCE, newTaskVentureId: null, lastReviewOn: null,
    morningAt: null, taskReminders: false, quietFrom: null, quietTo: null, ...PROFILE_DEFAULTS,
  };

  beforeAll(async () => {
    t = await testDb();
    store = openStore({ DB: t.db }, () => NOW);
    passwordHash = await hashPassword(PASSWORD);
    const clock = () => NOW;
    app = createApp({
      store, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney",
      identity: accountIdentity({
        store, now: clock, origin: ORIGIN, owner: "the-operator", operatorEmail: "", sessionSecret: "session-secret",
        google: null, fetch: async () => { throw new Error("a test reached the network"); },
      }),
      live: { publish: async () => {}, connect: async () => new Response("connected") },
    });
  });
  afterAll(() => t.dispose());

  async function account(): Promise<string> {
    const owner = `owner-${crypto.randomUUID()}`;
    expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
    return owner;
  }

  async function signIn(owner: string): Promise<string> {
    const res = await app(new Request(`${ORIGIN}/auth/sign-in`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: `${owner}@example.test`, password: PASSWORD }),
    }), () => {});
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  const call = (cookie: string, method: string, path: string, body?: unknown) => app(new Request(`${ORIGIN}${path}`, {
    method, headers: { origin: ORIGIN, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), () => {});

  const subscription = (endpoint = ENDPOINT, extra: Record<string, unknown> = {}) =>
    ({ endpoint, keys: { p256dh: P256DH, auth: AUTH }, ...extra });

  it("starts every reminder setting off, and keeps each one with the rest", async () => {
    const owner = await account();
    expect(await store.appearance(owner)).toEqual(EMPTY);
    const saved = must(await store.setAppearance(owner, { morningAt: "06:30", taskReminders: true, quietFrom: "21:00", quietTo: "07:00" }));
    expect(saved).toEqual({ ...EMPTY, morningAt: "06:30", taskReminders: true, quietFrom: "21:00", quietTo: "07:00" });
    expect(await store.appearance(owner)).toEqual(saved);
    expect(must(await store.setAppearance(owner, { theme: "dark" }))).toEqual({ ...saved, theme: "dark" });
    expect(must(await store.setAppearance(owner, { morningAt: null, taskReminders: false, quietFrom: null, quietTo: null })))
      .toEqual({ ...EMPTY, theme: "dark" });
  });

  it("takes the four keys on a patch and refuses a bad value", () => {
    expect(parseAppearance({ morningAt: "06:30" })).toEqual({ ok: true, value: { morningAt: "06:30" } });
    expect(parseAppearance({ taskReminders: false, quietFrom: null, quietTo: "07:00" }))
      .toEqual({ ok: true, value: { taskReminders: false, quietFrom: null, quietTo: "07:00" } });
    for (const bad of [
      { morningAt: "6:30" }, { morningAt: "25:00" }, { morningAt: 630 }, { morningAt: "" },
      { taskReminders: 1 }, { taskReminders: "yes" }, { taskReminders: null },
      { quietFrom: "9pm" }, { quietTo: "07:60" }, { quietFrom: {} },
    ]) {
      expect(parseAppearance(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(parseAppearance({ remindMorning: "06:30" })).toEqual({ ok: false, error: "appearance cannot change remindMorning" });
  });

  it("carries the settings over PATCH and GET /api/appearance, for one account only", async () => {
    const a = await account();
    const b = await account();
    const cookieA = await signIn(a);
    const cookieB = await signIn(b);
    const patched = await call(cookieA, "PATCH", "/api/appearance", { morningAt: "07:00", taskReminders: true });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ ...EMPTY, morningAt: "07:00", taskReminders: true });
    expect(await (await call(cookieA, "GET", "/api/appearance")).json()).toEqual({ ...EMPTY, morningAt: "07:00", taskReminders: true });
    expect(await (await call(cookieB, "GET", "/api/appearance")).json()).toEqual(EMPTY);
    const refused = await call(cookieA, "PATCH", "/api/appearance", { taskReminders: "on" });
    expect(refused.status).toBe(400);
  });

  it("serves one stable public key, and keeps the pair it made", async () => {
    const cookie = await signIn(await account());
    const first = (await (await call(cookie, "GET", "/api/push/key")).json()) as { publicKey: string };
    const second = (await (await call(cookie, "GET", "/api/push/key")).json()) as { publicKey: string };
    expect(first.publicKey).toBe(second.publicKey);
    const point = fromBase64Url(first.publicKey);
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
    const kept = await store.vapidKey();
    expect(kept?.publicKey).toBe(first.publicKey);
    // The stored pair can sign.
    const key = await importVapidSigningKey(kept ?? { publicKey: "", privateKey: "" });
    expect(key.type).toBe("private");
    // A second maker loses to the first.
    expect(await store.keepVapidKey(await makeVapidKey())).toEqual(kept);
  });

  it("uses the two secrets when both are set, and the kept pair when only one is", async () => {
    const own = { publicKey: "PUB", privateKey: "PRIV" };
    expect(await vapidKeys(store, own)).toEqual(own);
    const kept = await store.vapidKey();
    expect(await vapidKeys(store, { publicKey: "PUB" })).toEqual(kept);
    expect(await vapidKeys(store)).toEqual(kept);
  });

  it("subscribes a device, lists it without its keys, and unsubscribes it", async () => {
    const owner = await account();
    const cookie = await signIn(owner);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    expect(await (await call(cookie, "GET", "/api/push/subscriptions")).json()).toEqual({ subscriptions: [] });
    const made = await call(cookie, "POST", "/api/push/subscribe", subscription(endpoint, { label: "Pixel", tz: "Australia/Perth" }));
    expect(made.status).toBe(200);
    expect(await made.json()).toMatchObject({ endpoint, label: "Pixel", tz: "Australia/Perth", lastOkAt: null });
    const listed = (await (await call(cookie, "GET", "/api/push/subscriptions")).json()) as { subscriptions: Row[] };
    expect(listed.subscriptions).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(P256DH);
    expect(JSON.stringify(listed)).not.toContain(AUTH);
    // Again with the same endpoint is the same device, not a second one.
    await call(cookie, "POST", "/api/push/subscribe", subscription(endpoint, { tz: "Australia/Sydney" }));
    const again = (await (await call(cookie, "GET", "/api/push/subscriptions")).json()) as { subscriptions: Row[] };
    expect(again.subscriptions).toHaveLength(1);
    expect(again.subscriptions[0]?.tz).toBe("Australia/Sydney");
    const off = await call(cookie, "DELETE", "/api/push/subscribe", { endpoint });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ subscriptions: [] });
    // Nothing is destroyed: the row is archived, and turning reminders on again brings it back.
    const row = await t.db.prepare(`SELECT archived_at FROM push_subscription WHERE endpoint = ?`).bind(endpoint).first<Row>();
    expect(row?.archived_at).not.toBeNull();
    expect((await call(cookie, "DELETE", "/api/push/subscribe", { endpoint })).status).toBe(404);
    await call(cookie, "POST", "/api/push/subscribe", subscription(endpoint));
    expect(((await (await call(cookie, "GET", "/api/push/subscriptions")).json()) as { subscriptions: Row[] }).subscriptions).toHaveLength(1);
  });

  it("falls back to the page's zone when the device sends none", async () => {
    const cookie = await signIn(await account());
    const made = await call(cookie, "POST", "/api/push/subscribe?tz=Pacific/Auckland", subscription(`https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`));
    expect(await made.json()).toMatchObject({ tz: "Pacific/Auckland" });
    const bare = await call(cookie, "POST", "/api/push/subscribe", subscription(`https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`));
    expect(await bare.json()).toMatchObject({ tz: "Australia/Sydney" });
  });

  it("never shows one account another's subscriptions, and cannot unsubscribe them", async () => {
    const a = await account();
    const b = await account();
    const cookieA = await signIn(a);
    const cookieB = await signIn(b);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
    await call(cookieA, "POST", "/api/push/subscribe", subscription(endpoint));
    expect(await (await call(cookieB, "GET", "/api/push/subscriptions")).json()).toEqual({ subscriptions: [] });
    expect((await call(cookieB, "DELETE", "/api/push/subscribe", { endpoint })).status).toBe(404);
    expect(((await (await call(cookieA, "GET", "/api/push/subscriptions")).json()) as { subscriptions: Row[] }).subscriptions).toHaveLength(1);
  });

  it("refuses a bad subscription, a wrong method and a signed-out caller", async () => {
    const cookie = await signIn(await account());
    for (const bad of [
      {}, { endpoint: "http://push.example.test/x", keys: { p256dh: P256DH, auth: AUTH } },
      { endpoint: "not a url", keys: { p256dh: P256DH, auth: AUTH } },
      { endpoint: ENDPOINT }, { endpoint: ENDPOINT, keys: { p256dh: "short", auth: AUTH } },
      { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: "!" } },
      subscription(ENDPOINT, { tz: "Mars/Olympus" }), subscription(ENDPOINT, { extra: 1 }),
    ]) {
      expect((await call(cookie, "POST", "/api/push/subscribe", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(parsePushSubscription(subscription(), "UTC")).toMatchObject({ ok: true });
    expect((await call(cookie, "GET", "/api/push/subscribe")).status).toBe(405);
    expect((await call(cookie, "POST", "/api/push/key", {})).status).toBe(405);
    expect((await call(cookie, "DELETE", "/api/push/subscribe", {})).status).toBe(400);
    expect((await call(cookie, "GET", "/api/push/nothing")).status).toBe(404);
    expect((await call("", "GET", "/api/push/key")).status).toBe(401);
    expect((await call("", "GET", "/api/push/subscriptions")).status).toBe(401);
  });
});
