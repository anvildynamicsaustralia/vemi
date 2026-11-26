import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { hashPassword } from "./password.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { base32Decode, hashCode, totp } from "./totp.js";

/** 2-step sign-in, backup codes and the recovery code, through `createApp` and a real D1. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";
const NEXT = "another long password";

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

type Json = Record<string, unknown> & { error?: string; code?: string };

function world(sessionSecret = "session-secret") {
  const owner = `owner-${crypto.randomUUID()}`;
  const operator = `operator-${crypto.randomUUID()}@example.com`;
  let now = new Date("2026-09-14T02:00:00Z");
  const clock = () => now;
  const store = openStore({ DB: t.db }, clock);
  const identity = accountIdentity({
    store, now: clock, origin: ORIGIN, owner, operatorEmail: operator, sessionSecret,
    google: null, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney",
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  function device() {
    const jar = new Map<string, string>();
    const ip = `10.7.${++devices}.${Math.floor(Math.random() * 250)}`;
    return {
      async post(path: string, body: unknown): Promise<{ status: number; json: Json }> {
        const response = await app(
          new Request(`${ORIGIN}${path}`, {
            method: "POST",
            headers: {
              origin: ORIGIN, "cf-connecting-ip": ip, "content-type": "application/json",
              ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
            },
            body: JSON.stringify(body),
          }),
          () => {},
        );
        for (const line of response.headers.getSetCookie()) {
          const [pair = ""] = line.split(";");
          const at = pair.indexOf("=");
          const value = pair.slice(at + 1);
          if (/Max-Age=0/i.test(line) || value === "") jar.delete(pair.slice(0, at));
          else jar.set(pair.slice(0, at), value);
        }
        return { status: response.status, json: (await response.json()) as Json };
      },
      async me(): Promise<Json> {
        const response = await app(new Request(`${ORIGIN}/auth/me`, {
          headers: { origin: ORIGIN, "cf-connecting-ip": ip, ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}) },
        }), () => {});
        return (await response.json()) as Json;
      },
    };
  }
  /** An account made in the store with a password, signed in on a fresh device. */
  async function person() {
    const id = crypto.randomUUID();
    const email = `p-${crypto.randomUUID()}@example.com`;
    expect(await store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true })).toBe(true);
    const d = device();
    expect((await d.post("/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    return { id, email, d };
  }
  /** Sets 2-step up through the routes. */
  async function withTwoStep() {
    const p = await person();
    const setup = await p.d.post("/auth/two-step/setup", {});
    const secret = base32Decode(setup.json.secret as string)!;
    const verified = await p.d.post("/auth/two-step/verify", { code: await totp(secret, now.getTime()) });
    return { ...p, secret, backupCodes: verified.json.backupCodes as string[] };
  }
  return { owner, operator, store, device, person, withTwoStep, code: (secret: Uint8Array) => totp(secret, now.getTime()), advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe("2-step setup and verify", () => {
  it("setup answers the key and an otpauth link, and sign-in does not ask yet", async () => {
    const w = world();
    const p = await w.person();
    const setup = await p.d.post("/auth/two-step/setup", {});
    expect(setup.status).toBe(200);
    expect(setup.json.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.json.uri).toContain("otpauth://totp/");
    expect(setup.json.uri).toContain(`secret=${setup.json.secret as string}`);
    expect((await p.d.me()).twoStep).toBe(false);
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD })).status).toBe(200);
  });

  it("keeps the key sealed, not as the key itself", async () => {
    const w = world();
    const p = await w.person();
    const setup = await p.d.post("/auth/two-step/setup", {});
    const stored = (await w.store.account(p.id))?.twoStepSecret ?? "";
    expect(stored).not.toBe("");
    expect(stored).not.toContain(setup.json.secret as string);
  });

  it("refuses a wrong code and stays off, then a right one turns it on with ten backup codes", async () => {
    const w = world();
    const p = await w.person();
    const setup = await p.d.post("/auth/two-step/setup", {});
    const secret = base32Decode(setup.json.secret as string)!;
    expect((await p.d.post("/auth/two-step/verify", { code: "000000" })).status).toBe(400);
    expect((await p.d.me()).twoStep).toBe(false);
    const right = await p.d.post("/auth/two-step/verify", { code: await w.code(secret) });
    expect(right.status).toBe(200);
    const codes = right.json.backupCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect((await p.d.me()).twoStep).toBe(true);
    const row = await w.store.account(p.id);
    expect(row?.backupCodes).toHaveLength(10);
    expect(row?.backupCodes).not.toContain(codes[0]);
    expect(row?.backupCodes).toContain(await hashCode(codes[0]!));
  });

  it("verify before setup, and setup while on, are refused", async () => {
    const w = world();
    const p = await w.person();
    expect((await p.d.post("/auth/two-step/verify", { code: "123456" })).status).toBe(409);
    const on = await w.withTwoStep();
    expect((await on.d.post("/auth/two-step/setup", {})).status).toBe(409);
  });

  it("needs a signed-in person", async () => {
    const w = world();
    expect((await w.device().post("/auth/two-step/setup", {})).status).toBe(401);
    expect((await w.device().post("/auth/two-step/verify", { code: "123456" })).status).toBe(401);
    expect((await w.device().post("/auth/two-step/off", { password: PASSWORD })).status).toBe(401);
  });

  it("throttles wrong codes at setup like sign-in", async () => {
    const w = world();
    const p = await w.person();
    await p.d.post("/auth/two-step/setup", {});
    for (let i = 0; i < 5; i++) expect((await p.d.post("/auth/two-step/verify", { code: "000000" })).status).toBe(400);
    expect((await p.d.post("/auth/two-step/verify", { code: "000000" })).status).toBe(429);
  });
});

describe("signing in with 2-step on", () => {
  it("asks for a code after the right password", async () => {
    const w = world();
    const p = await w.withTwoStep();
    const out = await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD });
    expect(out.status).toBe(401);
    expect(out.json.code).toBe("two-step");
  });

  it("takes an app code, and refuses a wrong one", async () => {
    const w = world();
    const p = await w.withTwoStep();
    const d = w.device();
    expect((await d.post("/auth/sign-in", { email: p.email, password: PASSWORD, code: "000000" })).status).toBe(401);
    expect((await d.post("/auth/sign-in", { email: p.email, password: "wrong password here", code: await w.code(p.secret) })).status).toBe(401);
    expect((await d.post("/auth/sign-in", { email: p.email, password: PASSWORD, code: await w.code(p.secret) })).status).toBe(200);
  });

  it("refuses an app code used before, even inside its 90 second window, and takes the next step's", async () => {
    const w = world();
    const p = await w.withTwoStep();
    // Move off the step the setup code used, so this step's code is fresh.
    w.advance(30_000);
    const used = await w.code(p.secret);
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code: used })).status).toBe(200);
    expect((await w.store.account(p.id))?.totpLastStep).toBe(Math.floor((Date.parse("2026-09-14T02:00:00Z") + 30_000) / 30_000));
    // The same code again, now and a step later (still inside the window): a replay.
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code: used })).status).toBe(401);
    w.advance(30_000);
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code: used })).status).toBe(401);
    // The next step's own code is accepted.
    const next = await w.code(p.secret);
    expect(next).not.toBe(used);
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code: next })).status).toBe(200);
  });

  it("refuses an earlier step's code once a later one has signed in", async () => {
    const w = world();
    const p = await w.withTwoStep();
    w.advance(30_000);
    const earlier = await w.code(p.secret);
    w.advance(30_000);
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code: await w.code(p.secret) })).status).toBe(200);
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code: earlier })).status).toBe(401);
  });

  it("records a step once: the store refuses the same or an earlier step", async () => {
    const w = world();
    const p = await w.person();
    expect(await w.store.acceptTotpStep(p.id, 100)).toBe(true);
    expect(await w.store.acceptTotpStep(p.id, 100)).toBe(false);
    expect(await w.store.acceptTotpStep(p.id, 99)).toBe(false);
    expect(await w.store.acceptTotpStep(p.id, 101)).toBe(true);
  });

  it("takes a backup code once", async () => {
    const w = world();
    const p = await w.withTwoStep();
    const code = p.backupCodes[0]!;
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code })).status).toBe(200);
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code })).status).toBe(401);
    // A different one still works, typed lower case and without the dash.
    const other = p.backupCodes[1]!.toLowerCase().replace("-", " ");
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD, code: other })).status).toBe(200);
    expect((await w.store.account(p.id))?.backupCodes).toHaveLength(8);
  });

  it("throttles wrong codes, and a missing code is not counted", async () => {
    const w = world();
    const p = await w.withTwoStep();
    const d = w.device();
    for (let i = 0; i < 10; i++) expect((await d.post("/auth/sign-in", { email: p.email, password: PASSWORD })).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await d.post("/auth/sign-in", { email: p.email, password: PASSWORD, code: "000000" })).status).toBe(401);
    expect((await d.post("/auth/sign-in", { email: p.email, password: PASSWORD, code: await w.code(p.secret) })).status).toBe(429);
  });

  it("turns off with the password only, then sign-in is as before", async () => {
    const w = world();
    const p = await w.withTwoStep();
    expect((await p.d.post("/auth/two-step/off", {})).status).toBe(403);
    expect((await p.d.post("/auth/two-step/off", { password: "not the password" })).status).toBe(403);
    expect((await p.d.me()).twoStep).toBe(true);
    expect((await p.d.post("/auth/two-step/off", { password: PASSWORD })).status).toBe(200);
    const row = await w.store.account(p.id);
    expect(row?.twoStepSecret).toBeNull();
    expect(row?.twoStepOnAt).toBeNull();
    expect(row?.backupCodes).toEqual([]);
    expect((await w.device().post("/auth/sign-in", { email: p.email, password: PASSWORD })).status).toBe(200);
  });

  it("is off, not locked, once SESSION_SECRET changes", async () => {
    const w = world("first-secret");
    const p = await w.withTwoStep();
    const other = accountIdentity({
      store: w.store, now: () => new Date("2026-09-14T02:00:00Z"), origin: ORIGIN, owner: w.owner, operatorEmail: w.operator,
      sessionSecret: "second-secret", google: null, fetch: (async () => { throw new Error("no"); }) as typeof fetch,
    });
    const response = await other.handle(new Request(`${ORIGIN}/auth/sign-in`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: p.email, password: PASSWORD, code: await w.code(p.secret) }),
    }), () => {});
    expect(response?.status).toBe(401);
  });
});

describe("recovery code", () => {
  it("claim returns one once, stored only as a hash", async () => {
    const w = world();
    const d = w.device();
    const claimed = await d.post("/auth/claim", { email: w.operator, password: PASSWORD });
    expect(claimed.status).toBe(200);
    const code = claimed.json.recoveryCode as string;
    expect(code).toMatch(/^([A-Z2-9]{5}-){4}[A-Z2-9]{5}$/);
    const row = await t.db.prepare(`SELECT code_hash FROM recovery_code WHERE owner = ?`).bind(w.owner).first<{ code_hash: string }>();
    expect(row?.code_hash).toBe(await hashCode(code));
    expect(row?.code_hash).not.toContain(code);
  });

  it("invite accept returns one", async () => {
    const w = world();
    const d = w.device();
    await d.post("/auth/claim", { email: w.operator, password: PASSWORD });
    const made = await d.post("/auth/invite", { email: `new-${crypto.randomUUID()}@example.com` });
    const token = (made.json.link as string).split("#")[1]!;
    const accepted = await w.device().post("/auth/invite/accept", { token, password: PASSWORD });
    expect(accepted.status).toBe(200);
    expect(typeof accepted.json.recoveryCode).toBe("string");
  });

  it("a new one replaces the old, needs the password, and the old stops working", async () => {
    const w = world();
    const d = w.device();
    const claimed = await d.post("/auth/claim", { email: w.operator, password: PASSWORD });
    const old = claimed.json.recoveryCode as string;
    expect((await d.post("/auth/recovery/new", {})).status).toBe(403);
    const fresh = await d.post("/auth/recovery/new", { password: PASSWORD });
    expect(fresh.status).toBe(200);
    expect(fresh.json.recoveryCode).not.toBe(old);
    const tried = await w.device().post("/auth/recover", { email: w.operator, recoveryCode: old, password: NEXT });
    expect(tried.status).toBe(401);
    const used = await w.device().post("/auth/recover", { email: w.operator, recoveryCode: fresh.json.recoveryCode, password: NEXT });
    expect(used.status).toBe(200);
  });

  it("sets a new password, ends other sessions, spends the code and answers a fresh one", async () => {
    const w = world();
    const first = w.device();
    const claimed = await first.post("/auth/claim", { email: w.operator, password: PASSWORD });
    const code = claimed.json.recoveryCode as string;
    const back = w.device();
    const out = await back.post("/auth/recover", { email: w.operator.toUpperCase(), recoveryCode: code.toLowerCase().replaceAll("-", " "), password: NEXT });
    expect(out.status).toBe(200);
    expect(out.json.signedIn).toBe(true);
    expect(out.json.recoveryCode).not.toBe(code);
    expect((await back.me()).signedIn).toBe(true);
    expect((await first.me()).signedIn).toBe(false);
    expect((await w.device().post("/auth/sign-in", { email: w.operator, password: PASSWORD })).status).toBe(401);
    expect((await w.device().post("/auth/sign-in", { email: w.operator, password: NEXT })).status).toBe(200);
    // Spent: the same code does nothing twice.
    expect((await w.device().post("/auth/recover", { email: w.operator, recoveryCode: code, password: PASSWORD })).status).toBe(401);
    // The fresh one works.
    expect((await w.device().post("/auth/recover", { email: w.operator, recoveryCode: out.json.recoveryCode, password: PASSWORD })).status).toBe(200);
  });

  it("gets a person back in without their app: 2-step goes off", async () => {
    const w = world();
    const d = w.device();
    const claimed = await d.post("/auth/claim", { email: w.operator, password: PASSWORD });
    const setup = await d.post("/auth/two-step/setup", {});
    await d.post("/auth/two-step/verify", { code: await w.code(base32Decode(setup.json.secret as string)!) });
    expect((await d.me()).twoStep).toBe(true);
    const out = await w.device().post("/auth/recover", { email: w.operator, recoveryCode: claimed.json.recoveryCode, password: NEXT });
    expect(out.status).toBe(200);
    expect((await w.device().post("/auth/sign-in", { email: w.operator, password: NEXT })).status).toBe(200);
  });

  it("answers every miss the same way and throttles them", async () => {
    const w = world();
    const d = w.device();
    const claimed = await d.post("/auth/claim", { email: w.operator, password: PASSWORD });
    const stranger = await w.device().post("/auth/recover", { email: "nobody@example.com", recoveryCode: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", password: NEXT });
    const wrong = await w.device().post("/auth/recover", { email: w.operator, recoveryCode: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", password: NEXT });
    expect(stranger.status).toBe(401);
    expect(wrong).toEqual(stranger);
    const shortPassword = await w.device().post("/auth/recover", { email: w.operator, recoveryCode: claimed.json.recoveryCode, password: "short" });
    expect(shortPassword.status).toBe(400);
    // The wrong code and the short password counted against the address; three more reach five, then it is held.
    for (let i = 0; i < 3; i++) await w.device().post("/auth/recover", { email: w.operator, recoveryCode: "BBBBB-BBBBB-BBBBB-BBBBB-BBBBB", password: NEXT });
    const held = await w.device().post("/auth/recover", { email: w.operator, recoveryCode: claimed.json.recoveryCode, password: NEXT });
    expect(held.status).toBe(429);
  });
});
