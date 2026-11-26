import {
  fromBase64Url, keysFrom, makeAccountKey, makeRecoveryKey, pairingKeys, pairingPublic, formatRecoveryKey, parseRecoveryKey,
  openFromPairing, recoveryWrappingKey, sealForPairing, toBase64Url, unwrapKey, wrapKey,
} from "@vemi/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { hashPassword } from "./password.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** Wrapped keys and pairing, through `createApp` and a real D1. The server only ever holds ciphertext. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";
const START = new Date("2026-09-14T02:00:00Z");

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

type Json = Record<string, any>;

function world() {
  let at = START.getTime();
  const clock = () => new Date(at);
  const copyOwner = `copy-owner-${crypto.randomUUID()}`;
  const store = openStore({ DB: t.db }, clock);
  const identity = accountIdentity({
    store, now: clock, origin: ORIGIN, owner: copyOwner, operatorEmail: `op-${crypto.randomUUID()}@example.com`, sessionSecret: "session-secret",
    google: null, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney", copyOwner,
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  function person() {
    const jar = new Map<string, string>();
    const ip = `10.8.${++devices}.${Math.floor(Math.random() * 250)}`;
    const send = async (method: string, path: string, body?: unknown) => {
      const response = await app(new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          origin: ORIGIN, "cf-connecting-ip": ip,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), () => {});
      for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const eq = pair.indexOf("=");
        const value = pair.slice(eq + 1);
        if (/Max-Age=0/i.test(line) || value === "") jar.delete(pair.slice(0, eq));
        else jar.set(pair.slice(0, eq), value);
      }
      const text = await response.text();
      return { status: response.status, json: (text === "" ? {} : JSON.parse(text)) as Json, text };
    };
    return { send };
  }
  async function signedIn() {
    const id = `acct-${crypto.randomUUID()}`;
    const email = `p-${crypto.randomUUID()}@example.com`;
    expect(await store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true })).toBe(true);
    const p = person();
    expect((await p.send("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    return { ...p, id };
  }
  return { store, signedIn, person, forward: (ms: number) => { at += ms; }, clock };
}

const b64 = (n: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(n)));
const wrapId = () => `w${crypto.randomUUID().replaceAll("-", "")}`;

const device = (id = wrapId(), label = "Chrome on Windows") => ({ id, kind: "device", label });
const passkey = (deviceId: string | null, id = wrapId()) => ({
  id, kind: "passkey", label: "Face ID or fingerprint", deviceId, credentialId: b64(32), salt: b64(32), wrapped: `${b64(12)}.${b64(48)}`,
});
const password = (id = wrapId()) => ({ id, kind: "password", label: "Vault password", salt: b64(16), iterations: 600000, wrapped: `${b64(12)}.${b64(48)}` });
const recovery = (id = wrapId()) => ({ id, kind: "recovery", label: "Recovery key", wrapped: `${b64(12)}.${b64(48)}` });

const bundle = (wraps: unknown[], keyRef = b64(8), keyCheck = b64(16)) => ({ keyRef, keyCheck, wraps });

async function rowsOf(owner: string, table = "key_wrap") {
  return (await t.db.prepare(`SELECT * FROM ${table} WHERE owner = ? ORDER BY created_at, id`).bind(owner).all<Json>()).results;
}

describe("signed out", () => {
  it("answers 401 on every route", async () => {
    const w = world();
    const nobody = w.person();
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/keys"], ["POST", "/api/keys", bundle([device()])], ["POST", "/api/keys/x/archive", {}],
      ["POST", "/api/keys/recovery", { wrap: recovery() }], ["POST", "/api/keys/start-again", bundle([device()])],
      ["POST", "/api/key-pairing", { id: b64(16) }], ["PUT", `/api/key-pairing/${b64(16)}`, { sealed: "a.b.c" }],
      ["GET", `/api/key-pairing/${b64(16)}`],
    ];
    for (const [method, path, body] of calls) expect((await nobody.send(method, path, body)).status, `${method} ${path}`).toBe(401);
  });
});

describe("keys", () => {
  it("answers an empty set when there is no key", async () => {
    const p = await world().signedIn();
    expect(await p.send("GET", "/api/keys")).toMatchObject({ status: 200, json: { keyRef: null, keyCheck: null, wraps: [] } });
  });

  it("adds rows in one batch and answers them with the key ref and check", async () => {
    const p = await world().signedIn();
    const d = device();
    const pk = passkey(d.id);
    const sent = bundle([pk, d, password(), recovery()]);
    const added = await p.send("POST", "/api/keys", sent);
    expect(added.status).toBe(200);
    expect(added.json.keyRef).toBe(sent.keyRef);
    expect(added.json.keyCheck).toBe(sent.keyCheck);
    expect(added.json.wraps).toHaveLength(4);
    expect((await p.send("GET", "/api/keys")).json).toEqual(added.json);
    const stored = added.json.wraps.find((r: Json) => r.kind === "passkey");
    expect(stored).toMatchObject({ deviceId: d.id, credentialId: pk.credentialId, salt: pk.salt, wrapped: pk.wrapped });
    expect(added.json.wraps.find((r: Json) => r.kind === "device")).toMatchObject({ wrapped: null, salt: null, credentialId: null });
  });

  it("adds another way to the same key, and refuses rows of another key with 409", async () => {
    const p = await world().signedIn();
    const first = bundle([device(), recovery()]);
    expect((await p.send("POST", "/api/keys", first)).status).toBe(200);
    expect((await p.send("POST", "/api/keys", { ...first, wraps: [password()] })).json.wraps).toHaveLength(3);
    const other = await p.send("POST", "/api/keys", bundle([password()]));
    expect(other.status).toBe(409);
    expect((await p.send("GET", "/api/keys")).json.wraps).toHaveLength(3);
    const sameRefOtherCheck = await p.send("POST", "/api/keys", { ...first, keyCheck: b64(16), wraps: [password()] });
    expect(sameRefOtherCheck.status).toBe(409);
  });

  it("refuses a row id already used, and a passkey naming a device that is not there", async () => {
    const p = await world().signedIn();
    const first = bundle([device(), recovery()]);
    expect((await p.send("POST", "/api/keys", first)).status).toBe(200);
    expect((await p.send("POST", "/api/keys", { ...first, wraps: [first.wraps[0]] })).status).toBe(409);
    expect((await p.send("POST", "/api/keys", { ...first, wraps: [passkey("no-such-device")] })).status).toBe(404);
  });

  it("refuses a passkey naming another account's device row", async () => {
    const w = world();
    const a = await w.signedIn();
    const b = await w.signedIn();
    const d = device();
    expect((await a.send("POST", "/api/keys", bundle([d]))).status).toBe(200);
    const mine = bundle([recovery()]);
    expect((await b.send("POST", "/api/keys", mine)).status).toBe(200);
    expect((await b.send("POST", "/api/keys", { ...mine, wraps: [passkey(d.id)] })).status).toBe(404);
  });

  it("refuses unknown keys, bad base64url, a bad kind, a long wrapped copy and too many rows", async () => {
    const p = await world().signedIn();
    const good = bundle([device()]);
    const refuse = async (body: unknown, said: RegExp) => {
      const r = await p.send("POST", "/api/keys", body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(r.json.error).toMatch(said);
    };
    await refuse({ ...good, extra: 1 }, /cannot hold extra/);
    await refuse({ ...good, keyRef: "not base64!" }, /keyRef/);
    await refuse({ ...good, keyCheck: "" }, /keyCheck/);
    await refuse({ ...good, wraps: [] }, /wraps/);
    await refuse({ ...good, wraps: [{ ...device(), extra: true }] }, /cannot hold extra/);
    await refuse({ ...good, wraps: [{ ...recovery(), kind: "owner" }] }, /kind/);
    await refuse({ ...good, wraps: [{ ...recovery(), wrapped: "a".repeat(513) }] }, /wrapped/);
    await refuse({ ...good, wraps: [{ ...recovery(), wrapped: "bad bytes!" }] }, /wrapped/);
    await refuse({ ...good, wraps: [{ ...passkey(null), salt: "no spaces allowed" }] }, /salt/);
    await refuse({ ...good, wraps: [{ ...recovery(), label: "x".repeat(61) }] }, /label/);
    await refuse({ ...good, wraps: [{ ...device(), wrapped: b64(12) }] }, /device row/);
    await refuse({ ...good, wraps: [{ ...password(), iterations: null }] }, /password row/);
    await refuse({ ...good, wraps: [{ ...passkey(null), credentialId: null }] }, /passkey row/);
    await refuse({ ...good, wraps: [{ ...recovery(), wrapped: null }] }, /wrapped/);
    await refuse({ ...good, wraps: Array.from({ length: 11 }, () => device()) }, /1 to 10/);
    await refuse({ ...good, wraps: [device("same"), device("same")] }, /twice/);
    expect((await p.send("POST", "/api/keys", { ...good, wraps: Array.from({ length: 10 }, () => device()) })).status).toBe(200);
    expect((await p.send("PUT", "/api/keys", good)).status).toBe(405);
  });

  it("does not take a plain key, a password or any field it does not name", async () => {
    const p = await world().signedIn();
    for (const extra of ["accountKey", "fieldKey", "password", "recoveryKey"]) {
      expect((await p.send("POST", "/api/keys", { ...bundle([device()]), [extra]: b64(32) })).status).toBe(400);
    }
    expect((await p.send("GET", "/api/keys")).json.wraps).toEqual([]);
  });
});

describe("archive a row", () => {
  it("archives a device row and the passkey rows made on it, and nothing else", async () => {
    const w = world();
    const p = await w.signedIn();
    const phone = device(wrapId(), "Safari on iPhone");
    const desk = device(wrapId(), "Chrome on Windows");
    const sent = bundle([phone, desk, passkey(phone.id), passkey(desk.id), password(), recovery()]);
    expect((await p.send("POST", "/api/keys", sent)).status).toBe(200);
    const gone = await p.send("POST", `/api/keys/${phone.id}/archive`, {});
    expect(gone).toMatchObject({ status: 200, json: { archived: 2 } });
    const live = (await p.send("GET", "/api/keys")).json.wraps as Json[];
    expect(live.map((r) => r.kind).sort()).toEqual(["device", "passkey", "password", "recovery"]);
    expect(live.find((r) => r.kind === "device")?.id).toBe(desk.id);
    const all = await rowsOf(p.id);
    expect(all).toHaveLength(6);
    expect(all.filter((r) => r.archived_at !== null)).toHaveLength(2);
  });

  it("archives one non-device row alone, and a second archive is 404", async () => {
    const p = await world().signedIn();
    const pw = password();
    expect((await p.send("POST", "/api/keys", bundle([device(), pw]))).status).toBe(200);
    expect((await p.send("POST", `/api/keys/${pw.id}/archive`, {})).json).toEqual({ archived: 1 });
    expect((await p.send("POST", `/api/keys/${pw.id}/archive`, {})).status).toBe(404);
    expect(((await p.send("GET", "/api/keys")).json.wraps as Json[]).map((r) => r.kind)).toEqual(["device"]);
  });

  it("answers 404 for another account's row and leaves it live", async () => {
    const w = world();
    const a = await w.signedIn();
    const b = await w.signedIn();
    const d = device();
    expect((await a.send("POST", "/api/keys", bundle([d]))).status).toBe(200);
    expect((await b.send("POST", `/api/keys/${d.id}/archive`, {})).status).toBe(404);
    expect((await a.send("GET", "/api/keys")).json.wraps).toHaveLength(1);
    expect((await b.send("GET", "/api/keys")).json.wraps).toEqual([]);
    expect((await a.send("GET", `/api/keys/${d.id}/archive`)).status).toBe(405);
  });
});

describe("a new recovery key", () => {
  it("archives the live recovery row and adds the new one together", async () => {
    const p = await world().signedIn();
    const old = recovery();
    const sent = bundle([device(), password(), old]);
    expect((await p.send("POST", "/api/keys", sent)).status).toBe(200);
    const fresh = recovery();
    const done = await p.send("POST", "/api/keys/recovery", { wrap: fresh });
    expect(done.status).toBe(200);
    const live = done.json.wraps as Json[];
    expect(live.filter((r) => r.kind === "recovery").map((r) => r.id)).toEqual([fresh.id]);
    expect(done.json.keyRef).toBe(sent.keyRef);
    expect(live).toHaveLength(3);
    expect((await rowsOf(p.id)).find((r) => r.id === old.id)?.archived_at).not.toBeNull();
  });

  it("is 409 with no key, 400 for a row that is not a recovery row or has other fields", async () => {
    const p = await world().signedIn();
    expect((await p.send("POST", "/api/keys/recovery", { wrap: recovery() })).status).toBe(409);
    expect((await p.send("POST", "/api/keys", bundle([device()]))).status).toBe(200);
    expect((await p.send("POST", "/api/keys/recovery", { wrap: password() })).status).toBe(400);
    expect((await p.send("POST", "/api/keys/recovery", { wrap: recovery(), keyRef: b64(8) })).status).toBe(400);
    expect((await p.send("GET", "/api/keys/recovery")).status).toBe(405);
  });

  it("changes nothing when the new row clashes", async () => {
    const p = await world().signedIn();
    const old = recovery();
    expect((await p.send("POST", "/api/keys", bundle([device(), old]))).status).toBe(200);
    expect((await p.send("POST", "/api/keys/recovery", { wrap: { ...recovery(), id: old.id } })).status).toBe(409);
    expect(((await p.send("GET", "/api/keys")).json.wraps as Json[]).filter((r) => r.kind === "recovery").map((r) => r.id)).toEqual([old.id]);
  });
});

describe("start again", () => {
  it("archives every live row and adds the new key's rows, keeping the old rows", async () => {
    const p = await world().signedIn();
    const d = device();
    const old = bundle([d, passkey(d.id), password(), recovery()]);
    expect((await p.send("POST", "/api/keys", old)).status).toBe(200);
    const d2 = device();
    const next = bundle([d2, recovery()]);
    const done = await p.send("POST", "/api/keys/start-again", next);
    expect(done.status).toBe(200);
    expect(done.json.keyRef).toBe(next.keyRef);
    expect(done.json.wraps).toHaveLength(2);
    const all = await rowsOf(p.id);
    expect(all).toHaveLength(6);
    expect(all.filter((r) => r.archived_at !== null)).toHaveLength(4);
    expect(all.filter((r) => r.key_ref === old.keyRef)).toHaveLength(4);
    expect(all.filter((r) => r.key_ref === old.keyRef).every((r) => r.archived_at !== null)).toBe(true);
    // The old key can be added again after the new one is gone, but not beside it.
    expect((await p.send("POST", "/api/keys", { ...old, wraps: [password()] })).status).toBe(409);
  });

  it("works with no live rows and leaves another account's rows alone", async () => {
    const w = world();
    const a = await w.signedIn();
    const b = await w.signedIn();
    expect((await a.send("POST", "/api/keys", bundle([device()]))).status).toBe(200);
    expect((await b.send("POST", "/api/keys/start-again", bundle([device()]))).status).toBe(200);
    expect((await a.send("GET", "/api/keys")).json.wraps).toHaveLength(1);
    expect((await rowsOf(a.id)).every((r) => r.archived_at === null)).toBe(true);
  });

  it("changes nothing when a new row clashes with an old id", async () => {
    const p = await world().signedIn();
    const d = device();
    expect((await p.send("POST", "/api/keys", bundle([d]))).status).toBe(200);
    expect((await p.send("POST", "/api/keys/start-again", bundle([{ ...device(), id: d.id }]))).status).toBe(409);
    expect((await p.send("GET", "/api/keys")).json.wraps).toHaveLength(1);
  });
});

describe("pairing", () => {
  const parts = () => ({ sealed: `${b64(65)}.${b64(12)}.${b64(48)}` });

  it("opens for ten minutes, fills once, and is read once", async () => {
    const w = world();
    const p = await w.signedIn();
    const id = b64(16);
    const opened = await p.send("POST", "/api/key-pairing", { id });
    expect(opened).toMatchObject({ status: 200, json: { id, expiresAt: new Date(START.getTime() + 10 * 60 * 1000).toISOString() } });
    expect((await p.send("GET", `/api/key-pairing/${id}`)).json).toEqual({ waiting: true });
    expect((await p.send("GET", `/api/key-pairing/${id}`)).json).toEqual({ waiting: true });
    const filled = parts();
    expect((await p.send("PUT", `/api/key-pairing/${id}`, filled)).status).toBe(200);
    expect((await p.send("PUT", `/api/key-pairing/${id}`, parts())).status).toBe(409);
    expect((await p.send("GET", `/api/key-pairing/${id}`)).json).toEqual(filled);
    expect((await p.send("GET", `/api/key-pairing/${id}`)).status).toBe(404);
    expect((await p.send("PUT", `/api/key-pairing/${id}`, parts())).status).toBe(404);
    const [row] = await rowsOf(p.id, "key_pairing");
    expect(row?.archived_at).not.toBeNull();
  });

  it("refuses a taken id, a bad id and extra fields", async () => {
    const p = await world().signedIn();
    const id = b64(16);
    expect((await p.send("POST", "/api/key-pairing", { id })).status).toBe(200);
    expect((await p.send("POST", "/api/key-pairing", { id })).status).toBe(409);
    expect((await p.send("POST", "/api/key-pairing", { id: "short" })).status).toBe(400);
    expect((await p.send("POST", "/api/key-pairing", { id: "bad id with spaces!!" })).status).toBe(400);
    expect((await p.send("POST", "/api/key-pairing", { id: b64(16), secret: "x" })).status).toBe(400);
    expect((await p.send("PUT", `/api/key-pairing/${id}`, {})).status).toBe(400);
    expect((await p.send("PUT", `/api/key-pairing/${id}`, { ...parts(), publicPart: b64(65) })).status).toBe(400);
    expect((await p.send("PUT", `/api/key-pairing/${id}`, { ...parts(), extra: 1 })).status).toBe(400);
    expect((await p.send("PUT", `/api/key-pairing/${id}`, { sealed: "bad part!" })).status).toBe(400);
    expect((await p.send("PUT", `/api/key-pairing/${id}`, { sealed: "a".repeat(1025) })).status).toBe(400);
    expect((await p.send("GET", `/api/key-pairing/${b64(16)}`)).status).toBe(404);
    expect((await p.send("GET", "/api/key-pairing")).status).toBe(405);
    expect((await p.send("POST", `/api/key-pairing/${id}`, {})).status).toBe(405);
  });

  it("is 404 for another account, and that account cannot fill or read it", async () => {
    const w = world();
    const a = await w.signedIn();
    const b = await w.signedIn();
    const id = b64(16);
    expect((await a.send("POST", "/api/key-pairing", { id })).status).toBe(200);
    expect((await b.send("PUT", `/api/key-pairing/${id}`, parts())).status).toBe(404);
    expect((await b.send("GET", `/api/key-pairing/${id}`)).status).toBe(404);
    const filled = parts();
    expect((await a.send("PUT", `/api/key-pairing/${id}`, filled)).status).toBe(200);
    expect((await b.send("GET", `/api/key-pairing/${id}`)).status).toBe(404);
    expect((await a.send("GET", `/api/key-pairing/${id}`)).json).toEqual(filled);
  });

  it("is 404 once ten minutes have passed, filled or not", async () => {
    const w = world();
    const p = await w.signedIn();
    const idle = b64(16);
    const full = b64(16);
    expect((await p.send("POST", "/api/key-pairing", { id: idle })).status).toBe(200);
    expect((await p.send("POST", "/api/key-pairing", { id: full })).status).toBe(200);
    expect((await p.send("PUT", `/api/key-pairing/${full}`, parts())).status).toBe(200);
    w.forward(10 * 60 * 1000 + 1000);
    expect((await p.send("PUT", `/api/key-pairing/${idle}`, parts())).status).toBe(404);
    expect((await p.send("GET", `/api/key-pairing/${idle}`)).status).toBe(404);
    expect((await p.send("GET", `/api/key-pairing/${full}`)).status).toBe(404);
  });

  it("carries a real sealed key to the new device, which the server cannot open", async () => {
    const p = await world().signedIn();
    const accountKey = makeAccountKey();
    const id = b64(16);
    const fresh = await pairingKeys();
    expect((await p.send("POST", "/api/key-pairing", { id })).status).toBe(200);
    const sealed = await sealForPairing(accountKey, await pairingPublic(fresh), id);
    expect((await p.send("PUT", `/api/key-pairing/${id}`, { sealed })).status).toBe(200);
    const read = await p.send("GET", `/api/key-pairing/${id}`);
    expect(await openFromPairing(fresh, read.json.sealed, id)).toEqual(accountKey);
    expect(read.text).not.toContain(toBase64Url(accountKey));
  });
});

describe("export, restore and purge", () => {
  it("exports key_wrap rows and no key_pairing, and a restored wrapping still unwraps", async () => {
    const w = world();
    const p = await w.signedIn();
    const accountKey = makeAccountKey();
    const { keyRef, keyCheck } = await keysFrom(accountKey);
    const recoveryBytes = makeRecoveryKey();
    const written = await wrapKey(await recoveryWrappingKey(recoveryBytes), accountKey, "recovery", keyRef);
    const d = device();
    const pk = passkey(d.id);
    expect((await p.send("POST", "/api/keys", bundle([d, pk, { id: wrapId(), kind: "recovery", label: "Recovery key", wrapped: written }], keyRef, keyCheck))).status).toBe(200);
    expect((await p.send("POST", "/api/key-pairing", { id: b64(16) })).status).toBe(200);

    const exported = await p.send("GET", "/api/export");
    expect(exported.status).toBe(200);
    expect(Object.keys(exported.json.tables)).toContain("key_wrap");
    expect(Object.keys(exported.json.tables)).not.toContain("key_pairing");
    expect(exported.json.tables.key_wrap).toHaveLength(3);

    // Into a fresh account: every id is new, the wrapped copy and the references are the same.
    const q = await w.signedIn();
    const preview = await q.send("POST", "/api/restore", { document: exported.json });
    expect(preview.status, preview.text).toBe(200);
    const done = await q.send("POST", "/api/restore", { document: exported.json, confirm: "replace" });
    expect(done.status, done.text).toBe(200);
    const restored = (await q.send("GET", "/api/keys")).json;
    expect(restored.keyRef).toBe(keyRef);
    expect(restored.keyCheck).toBe(keyCheck);
    expect(restored.wraps).toHaveLength(3);
    const ids = (restored.wraps as Json[]).map((r) => r.id);
    expect(ids).not.toContain(d.id);
    const restoredPasskey = (restored.wraps as Json[]).find((r) => r.kind === "passkey");
    const restoredDevice = (restored.wraps as Json[]).find((r) => r.kind === "device");
    expect(restoredPasskey?.deviceId).toBe(restoredDevice?.id);
    const row = (restored.wraps as Json[]).find((r) => r.kind === "recovery");
    const typed = await parseRecoveryKey(await formatRecoveryKey(recoveryBytes));
    const opened = await unwrapKey(await recoveryWrappingKey(typed), row?.wrapped, "recovery", restored.keyRef);
    expect(opened).toEqual(accountKey);
    expect(fromBase64Url(restored.keyCheck)).not.toBeNull();
  });

  it("removes both tables' rows when the account is purged", async () => {
    const w = world();
    const p = await w.signedIn();
    expect((await p.send("POST", "/api/keys", bundle([device(), recovery()]))).status).toBe(200);
    expect((await p.send("POST", "/api/key-pairing", { id: b64(16) })).status).toBe(200);
    expect((await rowsOf(p.id)).length).toBe(2);
    expect((await rowsOf(p.id, "key_pairing")).length).toBe(1);
    expect((await w.store.scheduleDeletion(p.id)).ok).toBe(true);
    const later = openStore({ DB: t.db }, () => new Date(START.getTime() + 30 * 24 * 3600 * 1000));
    expect(await later.purgeAccounts("")).toBeGreaterThan(0);
    expect(await rowsOf(p.id)).toEqual([]);
    expect(await rowsOf(p.id, "key_pairing")).toEqual([]);
  });
});
