import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { envelopeLimit, isEnvelopeShape, open as openEnvelope, parsePushPayload, seal, type PushPayload } from "@vemi/shared";
import { hashPassword } from "./password.js";
import { GENERIC_TITLE, sendReminders } from "./reminders.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { makeVapidKey, toBase64Url } from "./vapid.js";

/**
 * The reminders tick for an account with full encryption on. Twin of `reminderTick.test.ts`
 * (the same fake clock, device and push service: change both). A plain account's pushes are
 * covered there and stay as they were; the device that opens the sealed title is the other
 * twin, `src/web/sw.js`, tested in `src/web/pushMessage.test.ts`. Here the
 * fake push service decrypts what it is sent like a device would, and every title is checked
 * to be absent from every push body, every push URL and every stored row the tick wrote.
 */

const PASSWORD = "a long enough password";
const SYDNEY = "Australia/Sydney";
// Sydney is UTC+11 in November: 23:00Z on the 17th is 10:00 on the 18th there.
const SYDNEY_10AM = "2026-11-17T23:00:00Z";

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

/** Reads a message the way the device would: RFC 8291 from the receiving side. Answers the JSON text. */
async function readBody(device: Device, body: Uint8Array): Promise<string> {
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
  return new TextDecoder().decode(plain.slice(0, plain.length - 1));
}

class Service {
  sent: { endpoint: string; body: Uint8Array }[] = [];
  readonly fetch: typeof fetch = async (input, init) => {
    const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.sent.push({ endpoint, body: init?.body as Uint8Array });
    return new Response(null, { status: 201 });
  };
  async raw(device: Device): Promise<string[]> {
    return Promise.all(this.sent.filter((s) => s.endpoint === device.endpoint).map((s) => readBody(device, s.body)));
  }
  async messages(device: Device): Promise<PushPayload[]> {
    return (await this.raw(device)).map((r) => {
      const parsed = parsePushPayload(JSON.parse(r));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    });
  }
}

let t: TestDb;
let store: Store;
let passwordHash: string;
let service: Service;
const vapid = { publicKey: "", privateKey: "", subject: "https://vemi.example.workers.dev" };

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
  readonly device: Device;
  readonly key: CryptoKey;
  readonly keyRef: string;
}

async function world(
  settings: { taskReminders?: boolean; morningAt?: string | null; quietFrom?: string | null; quietTo?: string | null },
  encryption: "on" | "off" = "on",
): Promise<World> {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
  const device = await makeDevice();
  await store.subscribePush(owner, { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth, label: null, tz: SYDNEY });
  must(await store.setAppearance(owner, settings));
  const key = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])) as CryptoKey;
  const keyRef = toBase64Url(crypto.getRandomValues(new Uint8Array(8)));
  if (encryption === "on") await t.db.prepare(`UPDATE account SET encryption = 'on' WHERE id = ?`).bind(owner).run();
  return { owner, venture, device, key, keyRef };
}

/** A task a device made while on: its title is stored as the envelope, bound to its own id. */
async function sealedTask(w: World, title: string, fields: Record<string, unknown> = {}) {
  const id = `task-${crypto.randomUUID()}`;
  const envelope = await seal(w.key, w.keyRef, title, { record: id, field: "title" });
  const made = must(await store.create(w.owner, "tasks", { id, ventureId: w.venture, title: envelope, ...fields } as never)).record;
  return { ...made, envelope };
}

const run = (at: string) =>
  sendReminders(store, { now: new Date(at), timeZone: SYDNEY, vapid: async () => vapid, post: service.fetch });

/** Every text cell of every table, the way a scan of the database would read them. */
async function everyStoredText(owner: string): Promise<string> {
  const tables = (await t.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string }>()).results;
  const parts: string[] = [];
  for (const { name } of tables) {
    const rows = (await t.db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>()).results;
    for (const row of rows) if (Object.values(row).some((v) => v === owner)) parts.push(JSON.stringify(row));
  }
  return parts.join("\n");
}

function expectNoPlain(titles: readonly string[], haystack: readonly string[]) {
  for (const title of titles) for (const where of haystack) expect(where).not.toContain(title);
}

describe("a task reminder for an account that is on", () => {
  it("carries the generic title and the task's own envelope, and no plaintext anywhere", async () => {
    const w = await world({ taskReminders: true });
    const made = await sealedTask(w, "Ring the solicitor about the lease", { remindAt: "2026-11-18T09:30" });
    await run(SYDNEY_10AM);
    await run(SYDNEY_10AM);
    const raw = await service.raw(w.device);
    expect(raw).toHaveLength(1);
    const [got] = await service.messages(w.device);
    expect(got).toEqual({
      kind: "task", title: GENERIC_TITLE, body: "", taskId: made.id, at: "2026-11-18T09:30", tag: `task-${made.id}`, sealedTitle: made.envelope,
    });
    expect(await openEnvelope(w.key, got!.sealedTitle!, { record: made.id, field: "title", keyRef: w.keyRef })).toBe("Ring the solicitor about the lease");
    expectNoPlain(["Ring the solicitor about the lease", "solicitor"], [
      ...raw, ...service.sent.map((s) => s.endpoint), await everyStoredText(w.owner),
    ]);
  });

  it("never sends a title that is not an envelope: the push says only that there is a reminder", async () => {
    const w = await world({ taskReminders: true }, "off");
    const made = must(await store.create(w.owner, "tasks", { id: `task-${crypto.randomUUID()}`, ventureId: w.venture, title: "Still plain", remindAt: "2026-11-18T09:30" } as never)).record;
    await t.db.prepare(`UPDATE account SET encryption = 'turning_on' WHERE id = ?`).bind(w.owner).run();
    await run(SYDNEY_10AM);
    const [got] = await service.messages(w.device);
    expect(got).toEqual({ kind: "task", title: GENERIC_TITLE, body: "", taskId: made.id, at: "2026-11-18T09:30", tag: `task-${made.id}` });
    expectNoPlain(["Still plain"], await service.raw(w.device));
  });

  it("holds for the quiet hours and sends the count with the first task's envelope", async () => {
    const w = await world({ taskReminders: true, quietFrom: "21:00", quietTo: "07:00" });
    const first = await sealedTask(w, "Quiet first title", { remindAt: "2026-11-17T23:00" });
    await sealedTask(w, "Quiet second title", { remindAt: "2026-11-18T02:00" });
    await run("2026-11-17T20:00:00Z"); // 07:00 in Sydney: the quiet is over
    const raw = await service.raw(w.device);
    const [got] = await service.messages(w.device);
    expect(got).toEqual({ kind: "held", title: "2 reminders", body: "", taskId: first.id, count: 2, tag: "held", sealedTitle: first.envelope });
    expectNoPlain(["Quiet first title", "Quiet second title"], [...raw, await everyStoredText(w.owner)]);
  });

  it("sends a lone held reminder as a task reminder with its envelope", async () => {
    const w = await world({ taskReminders: true, quietFrom: "21:00", quietTo: "07:00" });
    const only = await sealedTask(w, "Held alone", { remindAt: "2026-11-18T01:00" });
    await run("2026-11-17T20:00:00Z");
    const [got] = await service.messages(w.device);
    expect(got).toMatchObject({ kind: "task", title: GENERIC_TITLE, body: "", taskId: only.id, sealedTitle: only.envelope });
    expectNoPlain(["Held alone"], await service.raw(w.device));
  });
});

describe("the morning summary for an account that is on", () => {
  it("counts on the server and carries the first task's envelope", async () => {
    const w = await world({ morningAt: "06:30" });
    const first = await sealedTask(w, "Morning lead title", { pickedOn: "2026-11-18", todayPosition: 1 });
    await sealedTask(w, "Morning second title", { pickedOn: "2026-11-18", todayPosition: 2 });
    await run("2026-11-17T19:30:00Z"); // 06:30
    await run("2026-11-17T19:31:00Z");
    const raw = await service.raw(w.device);
    expect(raw).toHaveLength(1);
    const [got] = await service.messages(w.device);
    expect(got).toEqual({ kind: "morning", title: "2 on today", body: "", taskId: first.id, count: 2, tag: "morning", sealedTitle: first.envelope });
    expectNoPlain(["Morning lead title", "Morning second title"], [...raw, await everyStoredText(w.owner)]);
  });
});

describe("a 300 character title", () => {
  it("fits one push record as an envelope", async () => {
    const w = await world({ taskReminders: true });
    const title = "\u{1F600}".repeat(150);
    expect(title.length).toBe(300);
    const made = await sealedTask(w, title, { remindAt: "2026-11-18T09:30" });
    expect(made.envelope.length).toBeLessThanOrEqual(envelopeLimit(300));
    expect(isEnvelopeShape(made.envelope)).toBe(true);
    await run(SYDNEY_10AM);
    const [got] = await service.messages(w.device);
    expect(got?.sealedTitle).toBe(made.envelope);
  });
});

describe("a plain account", () => {
  it("is sent exactly what it always was", async () => {
    const w = await world({ taskReminders: true, morningAt: "06:30" }, "off");
    const made = must(await store.create(w.owner, "tasks", { id: `task-${crypto.randomUUID()}`, ventureId: w.venture, title: "Water plants", remindAt: "2026-11-18T09:30" } as never)).record;
    await run(SYDNEY_10AM);
    expect(await service.raw(w.device)).toEqual([
      JSON.stringify({ kind: "task", title: "Water plants", body: "", taskId: made.id, at: "2026-11-18T09:30", tag: `task-${made.id}` }),
    ]);
  });
});
