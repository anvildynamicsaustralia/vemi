import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parsePushPayload, type PushPayload } from "@vemi/shared";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { MAX_SENDS, isQuiet, localClock, remindersJob, sendReminders, wallMinus } from "./reminders.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { tick } from "./tick.js";
import { makeVapidKey, toBase64Url } from "./vapid.js";

/**
 * The reminders tick, with a fake clock and a fake push endpoint that really decrypts what it
 * is sent, so each assertion reads the message a person would see. Each test makes its own
 * account and device; `beforeEach` turns every earlier account's reminders off so one test's
 * leftovers never reach another's counts. `encryptedReminders.test.ts` is its twin for an
 * account with full encryption on (same device and push service: change both).
 */

const PASSWORD = "a long enough password";
const ORIGIN = "https://vemi.example.workers.dev";
const SYDNEY = "Australia/Sydney";

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

const text = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hkdf(ikm: BufferSource, salt: Uint8Array, info: Uint8Array, bits: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits);
}

interface Device {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly jwk: JsonWebKey;
  readonly authBytes: Uint8Array;
  readonly publicBytes: Uint8Array;
}

async function makeDevice(): Promise<Device> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicBytes = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint: `https://push.example.test/send/${crypto.randomUUID()}`,
    p256dh: toBase64Url(publicBytes), auth: toBase64Url(authBytes), jwk, authBytes, publicBytes,
  };
}

/** Reads a message the way the device would: RFC 8291 from the receiving side. */
async function open(device: Device, body: Uint8Array): Promise<PushPayload> {
  const salt = body.slice(0, 16);
  const senderPublic = body.slice(21, 21 + body[20]!);
  const curve = { name: "ECDH", namedCurve: "P-256" } as const;
  const mine = await crypto.subtle.importKey("jwk", device.jwk, curve, false, ["deriveBits"]);
  const theirs = await crypto.subtle.importKey("raw", senderPublic, curve, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: theirs } as unknown as SubtleCryptoDeriveKeyAlgorithm, mine, 256);
  const ikm = await hkdf(shared, device.authBytes, join(text("WebPush: info\0"), device.publicBytes, senderPublic), 256);
  const cek = await hkdf(ikm, salt, text("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, text("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(21 + senderPublic.length)));
  const parsed = parsePushPayload(JSON.parse(new TextDecoder().decode(plain.slice(0, plain.length - 1))));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** A push service that records what it is sent and answers with whatever status it is told. */
class Service {
  status = 201;
  sent: { endpoint: string; body: Uint8Array }[] = [];
  readonly fetch: typeof fetch = async (input, init) => {
    const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.sent.push({ endpoint, body: init?.body as Uint8Array });
    return new Response(null, { status: this.status });
  };
  to(device: Device) {
    return this.sent.filter((s) => s.endpoint === device.endpoint);
  }
  async messages(device: Device): Promise<PushPayload[]> {
    return Promise.all(this.to(device).map((s) => open(device, s.body)));
  }
}

let t: TestDb;
let store: Store;
let passwordHash: string;
let service: Service;
const vapid = { publicKey: "", privateKey: "", subject: ORIGIN };

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => new Date("2026-11-17T00:00:00Z"));
  passwordHash = await hashPassword(PASSWORD);
  Object.assign(vapid, await makeVapidKey());
}, 60_000);
afterAll(() => t.dispose());
beforeEach(async () => {
  await t.db.prepare(`UPDATE account SET remind_tasks = 0, remind_morning = NULL`).run();
  service = new Service();
});

interface World {
  readonly owner: string;
  readonly venture: string;
  readonly finished: string;
  readonly device: Device;
}

async function world(
  settings: { taskReminders?: boolean; morningAt?: string | null; quietFrom?: string | null; quietTo?: string | null } = { taskReminders: true },
  tz = SYDNEY,
): Promise<World> {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
  const states = must(await store.list(owner, "states", { venture }));
  const device = await makeDevice();
  await store.subscribePush(owner, { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth, label: null, tz });
  must(await store.setAppearance(owner, settings));
  return { owner, venture, finished: states.find((s) => s.kind === "finished")!.id, device };
}

async function task(w: World, title: string, fields: Record<string, unknown> = {}) {
  return must(await store.create(w.owner, "tasks", { id: `task-${crypto.randomUUID()}`, ventureId: w.venture, title, ...fields } as never)).record;
}

/** Runs the job's pass at an instant, as the tick would, against the fake push service. */
const run = (at: string, maxSends?: number) =>
  sendReminders(store, {
    now: new Date(at), timeZone: SYDNEY, vapid: async () => vapid, post: service.fetch,
    ...(maxSends === undefined ? {} : { maxSends }),
  });

// Sydney is UTC+11 in November: 23:00Z on the 17th is 10:00 on the 18th there.
const SYDNEY_10AM = "2026-11-17T23:00:00Z";

describe("the clock helpers", () => {
  it("reads a zone's wall time, and falls back on a zone it does not know", () => {
    expect(localClock(new Date(SYDNEY_10AM), SYDNEY, "UTC")).toEqual({ date: "2026-11-18", time: "10:00" });
    expect(localClock(new Date(SYDNEY_10AM), "Not/AZone", "UTC")).toEqual({ date: "2026-11-17", time: "23:00" });
    expect(wallMinus("2026-11-18T10:00", 24 * 60)).toBe("2026-11-17T10:00");
  });
  it("knows a window that crosses midnight, and no window", () => {
    expect(isQuiet("23:00", "21:00", "07:00")).toBe(true);
    expect(isQuiet("06:59", "21:00", "07:00")).toBe(true);
    expect(isQuiet("07:00", "21:00", "07:00")).toBe(false);
    expect(isQuiet("12:00", "13:00", "14:00")).toBe(false);
    expect(isQuiet("23:00", null, null)).toBe(false);
  });
});

describe("a task reminder", () => {
  it("is sent once when due, and not again on a re-run of the same minute", async () => {
    const w = await world();
    const made = await task(w, "Water plants", { remindAt: "2026-11-18T09:30" });
    await run(SYDNEY_10AM);
    await run(SYDNEY_10AM);
    await run("2026-11-17T23:01:00Z");
    const got = await service.messages(w.device);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "task", title: "Water plants", taskId: made.id, at: "2026-11-18T09:30", tag: `task-${made.id}` });
  });

  it("waits until its time, and is let go after a day", async () => {
    const w = await world();
    await task(w, "Later", { remindAt: "2026-11-18T10:01" });
    await task(w, "Long gone", { remindAt: "2026-11-17T09:59" });
    await run(SYDNEY_10AM);
    expect(service.to(w.device)).toHaveLength(0);
    await run("2026-11-17T23:01:00Z");
    expect((await service.messages(w.device)).map((m) => m.title)).toEqual(["Later"]);
  });

  it("is sent again when snoozed to a new time", async () => {
    const w = await world();
    const made = await task(w, "Call back", { remindAt: "2026-11-18T09:30" });
    await run(SYDNEY_10AM);
    must(await store.update(w.owner, "tasks", made.id, { remindAt: "2026-11-18T09:45" }, "2026-11-18"));
    await run("2026-11-17T23:01:00Z");
    expect((await service.messages(w.device)).map((m) => m.at)).toEqual(["2026-11-18T09:30", "2026-11-18T09:45"]);
  });

  it("is not sent for a finished or an archived task", async () => {
    const w = await world();
    const done = await task(w, "Done already", { remindAt: "2026-11-18T09:30" });
    const shelved = await task(w, "Shelved", { remindAt: "2026-11-18T09:30" });
    await task(w, "Still open", { remindAt: "2026-11-18T09:30" });
    must(await store.update(w.owner, "tasks", done.id, { stateId: w.finished }, "2026-11-18"));
    must(await store.setArchived(w.owner, "tasks", shelved.id, true));
    await run(SYDNEY_10AM);
    expect((await service.messages(w.device)).map((m) => m.title)).toEqual(["Still open"]);
  });

  it("reads each account's own day, far from UTC in either direction", async () => {
    const east = await world({ taskReminders: true }, "Pacific/Kiritimati");
    const west = await world({ taskReminders: true }, "Pacific/Pago_Pago");
    // 23:00Z on the 17th: 13:00 on the 18th at UTC+14, and 12:00 on the 17th at UTC-11.
    await task(east, "East due", { remindAt: "2026-11-18T12:30" });
    await task(east, "East not yet", { remindAt: "2026-11-18T13:30" });
    await task(west, "West due", { remindAt: "2026-11-17T11:30" });
    await task(west, "West not yet", { remindAt: "2026-11-18T12:30" });
    await run(SYDNEY_10AM);
    expect((await service.messages(east.device)).map((m) => m.title)).toEqual(["East due"]);
    expect((await service.messages(west.device)).map((m) => m.title)).toEqual(["West due"]);
  });

  it("is not sent when the account has everything off, or no device", async () => {
    const off = await world({});
    await task(off, "Quiet", { remindAt: "2026-11-18T09:30" });
    const bare = await world({ taskReminders: true });
    await store.unsubscribePush(bare.owner, bare.device.endpoint);
    await task(bare, "No device", { remindAt: "2026-11-18T09:30" });
    await run(SYDNEY_10AM);
    expect(service.sent).toHaveLength(0);
  });

  it("never reaches another account's device", async () => {
    const mine = await world();
    const other = await world();
    await task(mine, "Mine", { remindAt: "2026-11-18T09:30" });
    await run(SYDNEY_10AM);
    expect(service.to(mine.device)).toHaveLength(1);
    expect(service.to(other.device)).toHaveLength(0);
  });
});

describe("quiet hours", () => {
  it("hold reminders and send one grouped message when they end", async () => {
    const w = await world({ taskReminders: true, quietFrom: "21:00", quietTo: "07:00" });
    await task(w, "Late one", { remindAt: "2026-11-17T23:00" });
    await task(w, "Small hours", { remindAt: "2026-11-18T02:00" });
    await run("2026-11-17T16:00:00Z"); // 03:00 in Sydney: quiet
    expect(service.sent).toHaveLength(0);
    await run("2026-11-17T19:59:00Z"); // 06:59: still quiet
    expect(service.sent).toHaveLength(0);
    await run("2026-11-17T20:00:00Z"); // 07:00: the quiet is over
    await run("2026-11-17T20:00:00Z");
    await run("2026-11-17T20:01:00Z");
    const got = await service.messages(w.device);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "held", title: "2 reminders", body: "Late one", count: 2, tag: "held" });
  });

  it("send a lone held reminder as itself, and one due after the quiet as itself", async () => {
    const w = await world({ taskReminders: true, quietFrom: "21:00", quietTo: "07:00" });
    await task(w, "Held", { remindAt: "2026-11-18T01:00" });
    await task(w, "Morning", { remindAt: "2026-11-18T07:00" });
    await run("2026-11-17T20:00:00Z");
    expect((await service.messages(w.device)).map((m) => [m.kind, m.title]).sort())
      .toEqual([["task", "Held"], ["task", "Morning"]]);
  });
});

describe("the morning summary", () => {
  it("goes once a day at the chosen time, naming the count and the first task", async () => {
    const w = await world({ morningAt: "06:30" });
    await task(w, "First", { pickedOn: "2026-11-18", todayPosition: 1 });
    await task(w, "Second", { pickedOn: "2026-11-18", todayPosition: 2 });
    const finished = await task(w, "Third", { pickedOn: "2026-11-18", todayPosition: 3 });
    await task(w, "Not picked");
    must(await store.update(w.owner, "tasks", finished.id, { stateId: w.finished }, "2026-11-18"));
    await run("2026-11-17T19:29:00Z"); // 06:29
    expect(service.sent).toHaveLength(0);
    await run("2026-11-17T19:30:00Z");
    await run("2026-11-17T19:30:00Z");
    await run("2026-11-17T19:31:00Z");
    const got = await service.messages(w.device);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "morning", title: "2 on today", body: "First", count: 2, tag: "morning" });
    await task(w, "Next day", { pickedOn: "2026-11-19" });
    await run("2026-11-18T19:30:00Z"); // 06:30 on the 19th
    expect((await service.messages(w.device)).map((m) => m.title)).toEqual(["2 on today", "1 on today"]);
  });

  it("waits out the quiet hours and says nothing for an empty day", async () => {
    const w = await world({ morningAt: "06:30", quietFrom: "21:00", quietTo: "07:00" });
    await task(w, "Only", { pickedOn: "2026-11-18" });
    await run("2026-11-17T19:30:00Z"); // 06:30, quiet
    expect(service.sent).toHaveLength(0);
    await run("2026-11-17T20:00:00Z"); // 07:00
    expect((await service.messages(w.device)).map((m) => m.title)).toEqual(["1 on today"]);
    const empty = await world({ morningAt: "06:30" });
    await run("2026-11-17T19:30:00Z");
    expect(service.to(empty.device)).toHaveLength(0);
  });
});

describe("a push service that does not take the message", () => {
  it("drops a device it has forgotten, and keeps the reminder for no one else", async () => {
    const w = await world();
    await task(w, "Gone", { remindAt: "2026-11-18T09:30" });
    service.status = 410;
    await run(SYDNEY_10AM);
    expect(service.to(w.device)).toHaveLength(1);
    expect(await store.pushSubscriptions(w.owner)).toEqual([]);
  });

  it("keeps a device that failed and tries again next minute", async () => {
    const w = await world();
    await task(w, "Try again", { remindAt: "2026-11-18T09:30" });
    service.status = 503;
    await run(SYDNEY_10AM);
    expect(await store.pushSubscriptions(w.owner)).toHaveLength(1);
    service.status = 201;
    await run("2026-11-17T23:01:00Z");
    await run("2026-11-17T23:02:00Z");
    expect(service.to(w.device)).toHaveLength(2);
    expect((await store.pushSubscriptions(w.owner))[0]!.lastOkAt).not.toBeNull();
  });
});

describe("the send budget", () => {
  it("spreads 120 due reminders over later ticks and loses none", async () => {
    const w = await world();
    const titles = new Set<string>();
    for (let n = 0; n < 120; n++) {
      const title = `Reminder ${String(n).padStart(3, "0")}`;
      titles.add(title);
      await task(w, title, { remindAt: "2026-11-18T09:00" });
    }
    const counts: number[] = [];
    for (let minute = 0; minute < 5; minute++) {
      const before = service.sent.length;
      await run(`2026-11-17T23:0${minute}:00Z`);
      counts.push(service.sent.length - before);
    }
    expect(MAX_SENDS).toBe(40);
    expect(counts).toEqual([40, 40, 40, 0, 0]);
    const got = (await service.messages(w.device)).map((m) => m.title);
    expect(got).toHaveLength(120);
    expect(new Set(got)).toEqual(titles);
  }, 120_000);
});

describe("the registered job", () => {
  it("is the reminders job, every minute, and runs through tick", async () => {
    expect(remindersJob).toMatchObject({ name: "reminders", schedule: "* * * * *" });
    const w = await world();
    await task(w, "Through tick", { remindAt: "2026-11-18T09:30" });
    // The job posts with the global fetch; point it at the fake push service for this one call.
    const realFetch = globalThis.fetch;
    globalThis.fetch = service.fetch;
    try {
      await tick(new Date(SYDNEY_10AM), { DB: t.db }, [remindersJob]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect((await service.messages(w.device)).map((m) => m.title)).toEqual(["Through tick"]);
  });
});

describe("POST /api/push/test", () => {
  let app: App;
  beforeAll(() => {
    const clock = () => new Date(SYDNEY_10AM);
    app = createApp({
      store, now: clock, origin: ORIGIN, timeZone: SYDNEY, push: (input, init) => service.fetch(input, init),
      identity: accountIdentity({
        store, now: clock, origin: ORIGIN, owner: "the-operator", operatorEmail: "", sessionSecret: "session-secret",
        google: null, fetch: async () => { throw new Error("a test reached the network"); },
      }),
      live: { publish: async () => {}, connect: async () => new Response("connected") },
    });
  });

  async function signIn(owner: string): Promise<string> {
    const res = await app(new Request(`${ORIGIN}/auth/sign-in`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: `${owner}@example.test`, password: PASSWORD }),
    }), () => {});
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  it("sends a test to the caller's own devices and no one else's", async () => {
    const mine = await world({});
    const other = await world({});
    const cookie = await signIn(mine.owner);
    const res = await app(new Request(`${ORIGIN}/api/push/test`, { method: "POST", headers: { origin: ORIGIN, cookie } }), () => {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: 1, sent: 1 });
    expect((await service.messages(mine.device)).map((m) => m.kind)).toEqual(["test"]);
    expect(service.to(other.device)).toHaveLength(0);
    const get = await app(new Request(`${ORIGIN}/api/push/test`, { method: "GET", headers: { cookie } }), () => {});
    expect(get.status).toBe(405);
  });
});
