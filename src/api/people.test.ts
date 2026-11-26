import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** People by link: the owner invites a first name, passes on a link, lists, removes and resets. No mail. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";
const DAY = 24 * 3600 * 1000;

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

const unique = (stem: string): string => `${stem}-${crypto.randomUUID()}@example.com`;

function world() {
  const owner = `owner-${crypto.randomUUID()}`;
  const operator = unique("operator");
  let now = new Date("2026-09-14T02:00:00Z");
  const clock = () => now;
  const store = openStore({ DB: t.db }, clock);
  const identity = accountIdentity({
    store, now: clock, origin: ORIGIN, owner, operatorEmail: operator, sessionSecret: "session-secret", google: null,
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney",
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  const device = () => {
    const jar = new Map<string, string>();
    const ip = `10.1.${++devices}.1`;
    return {
      async call(method: string, path: string, body?: unknown): Promise<Response> {
        const response = await app(new Request(`${ORIGIN}${path}`, {
          method,
          headers: {
            origin: ORIGIN, "cf-connecting-ip": ip,
            ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), () => {});
        for (const line of response.headers.getSetCookie()) {
          const [pair = ""] = line.split(";");
          const at = pair.indexOf("=");
          const value = pair.slice(at + 1);
          if (/Max-Age=0/i.test(line) || value === "") jar.delete(pair.slice(0, at));
          else jar.set(pair.slice(0, at), value);
        }
        return response;
      },
    };
  };
  return { owner, operator, store, device, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

type World = ReturnType<typeof world>;
type Device = ReturnType<World["device"]>;
const body = async <T = Record<string, any>>(r: Response): Promise<T> => r.json() as Promise<T>;
const tokenOf = (link: string): string => link.slice(link.indexOf("#") + 1);

async function owned(w: World): Promise<Device> {
  const d = w.device();
  expect((await d.call("POST", "/auth/claim", { email: w.operator, password: PASSWORD })).status).toBe(200);
  return d;
}

async function invited(op: Device, firstName: string): Promise<string> {
  const made = await op.call("POST", "/auth/people/invite", { firstName });
  expect(made.status).toBe(200);
  return tokenOf((await body<{ link: string }>(made)).link);
}

/** The owner makes a link and a person accepts it with email and password. */
async function join(w: World, op: Device, firstName: string) {
  const email = unique("friend");
  const guest = w.device();
  const accepted = await guest.call("POST", "/auth/invite/accept", { token: await invited(op, firstName), email, password: PASSWORD });
  expect(accepted.status).toBe(200);
  const listed = await w.store.people(w.owner);
  const id = listed.people.find((p) => p.email === email)?.id;
  expect(id).toBeDefined();
  return { guest, email, id: id as string };
}

describe("making a link from a first name", () => {
  it("hands the owner a link good for seven days, and lists it as waiting", async () => {
    const w = world();
    const op = await owned(w);
    const made = await op.call("POST", "/auth/people/invite", { firstName: "  Sam " });
    expect(made.status).toBe(200);
    const { link, expiresAt } = await body<{ link: string; expiresAt: string }>(made);
    expect(link).toMatch(new RegExp(`^${ORIGIN}/invite#[A-Za-z0-9_-]{43}$`));
    expect(expiresAt).toBe("2026-09-21T02:00:00.000Z");
    const listed = await body<{ people: unknown[]; invites: { firstName: string; id: string }[] }>(await op.call("GET", "/auth/people"));
    expect(listed.people).toEqual([]);
    expect(listed.invites.map((i) => i.firstName)).toEqual(["Sam"]);
    // The link is stored only as a hash.
    expect(JSON.stringify(listed)).not.toContain(tokenOf(link));
  });

  it("refuses a missing, empty, long or non-text name", async () => {
    const w = world();
    const op = await owned(w);
    for (const firstName of [undefined, "", "   ", 5, "x".repeat(61)]) {
      expect((await op.call("POST", "/auth/people/invite", { firstName })).status).toBe(400);
    }
  });

  it("answers the first name on the link, and refuses a made-up or expired one", async () => {
    const w = world();
    const op = await owned(w);
    const token = await invited(op, "Sam");
    const d = w.device();
    expect(await body(await d.call("POST", "/auth/link", { token, purpose: "invite" }))).toEqual({ firstName: "Sam" });
    expect((await d.call("POST", "/auth/link", { token: "made-up", purpose: "invite" })).status).toBe(400);
    w.advance(7 * DAY + 1);
    expect((await d.call("POST", "/auth/link", { token, purpose: "invite" })).status).toBe(400);
  });
});

describe("accepting", () => {
  it("makes the account from an email and a password, once, and the person starts signed in", async () => {
    const w = world();
    const op = await owned(w);
    const token = await invited(op, "Sam");
    const email = unique("sam");
    const guest = w.device();
    const accepted = await guest.call("POST", "/auth/invite/accept", { token, email: ` ${email.toUpperCase()} `, password: PASSWORD });
    expect(accepted.status).toBe(200);
    expect(await body(accepted)).toMatchObject({ signedIn: true, recoveryCode: expect.any(String) });
    expect(await body(await guest.call("GET", "/auth/me"))).toMatchObject({ signedIn: true, email, operator: false, firstName: "Sam" });
    // Single use.
    expect((await w.device().call("POST", "/auth/invite/accept", { token, email: unique("again"), password: PASSWORD })).status).toBe(400);
    const listed = await body<{ people: { firstName: string; email: string }[]; invites: unknown[] }>(await op.call("GET", "/auth/people"));
    expect(listed.invites).toEqual([]);
    expect(listed.people).toMatchObject([{ firstName: "Sam", email }]);
  });

  it("needs a real address and a good password, and leaves the link usable after a refusal", async () => {
    const w = world();
    const op = await owned(w);
    const token = await invited(op, "Sam");
    const d = w.device();
    expect((await d.call("POST", "/auth/invite/accept", { token, password: PASSWORD })).status).toBe(400);
    expect((await d.call("POST", "/auth/invite/accept", { token, email: "nonsense", password: PASSWORD })).status).toBe(400);
    expect((await d.call("POST", "/auth/invite/accept", { token, email: unique("x"), password: "short" })).status).toBe(400);
    const ownersEmail = (await w.store.account(w.owner))?.email ?? "";
    expect((await d.call("POST", "/auth/invite/accept", { token, email: ownersEmail, password: PASSWORD })).status).toBe(409);
    expect((await d.call("POST", "/auth/invite/accept", { token, email: unique("ok"), password: PASSWORD })).status).toBe(200);
  });

  it("refuses an expired link", async () => {
    const w = world();
    const op = await owned(w);
    const token = await invited(op, "Sam");
    w.advance(7 * DAY + 1);
    expect((await w.device().call("POST", "/auth/invite/accept", { token, email: unique("late"), password: PASSWORD })).status).toBe(400);
  });
});

describe("the owner's list", () => {
  it("withdraws a waiting invite so its link stops working, and keeps the row", async () => {
    const w = world();
    const op = await owned(w);
    const token = await invited(op, "Sam");
    const [waiting] = (await body<{ invites: { id: string }[] }>(await op.call("GET", "/auth/people"))).invites;
    expect((await op.call("POST", "/auth/people/withdraw", { id: waiting?.id })).status).toBe(200);
    expect((await op.call("POST", "/auth/people/withdraw", { id: waiting?.id })).status).toBe(404);
    expect((await w.device().call("POST", "/auth/invite/accept", { token, email: unique("no"), password: PASSWORD })).status).toBe(400);
    const row = await t.db.prepare(`SELECT archived_at FROM invite WHERE id = ?`).bind(waiting?.id).first<{ archived_at: string | null }>();
    expect(row?.archived_at).not.toBeNull();
  });

  it("removes a person by scheduling their deletion, who can still sign in until then", async () => {
    const w = world();
    const op = await owned(w);
    const sam = await join(w, op, "Sam");
    const removed = await op.call("POST", "/auth/people/remove", { id: sam.id });
    expect(removed.status).toBe(200);
    expect(await body(removed)).toMatchObject({ deleteOn: "2026-09-21T02:00:00.000Z" });
    expect(await w.store.deletion(sam.id)).toBe("2026-09-21T02:00:00.000Z");
    expect((await w.device().call("POST", "/auth/sign-in", { email: sam.email, password: PASSWORD })).status).toBe(200);
    const listed = await body<{ people: { deleteOn: string | null }[] }>(await op.call("GET", "/auth/people"));
    expect(listed.people[0]?.deleteOn).toBe("2026-09-21T02:00:00.000Z");
  });

  it("will not remove the owner, a stranger or nobody", async () => {
    const w = world();
    const op = await owned(w);
    expect((await op.call("POST", "/auth/people/remove", { id: w.owner })).status).toBe(404);
    expect((await op.call("POST", "/auth/people/remove", { id: "nobody" })).status).toBe(404);
    expect((await op.call("POST", "/auth/people/remove", {})).status).toBe(400);
    expect(await w.store.deletion(w.owner)).toBeNull();
  });

  it("issues a reset link good for 24 hours that sets a new password, once", async () => {
    const w = world();
    const op = await owned(w);
    const sam = await join(w, op, "Sam");
    const made = await op.call("POST", "/auth/people/reset", { id: sam.id });
    expect(made.status).toBe(200);
    const { link, expiresAt } = await body<{ link: string; expiresAt: string }>(made);
    expect(link).toMatch(new RegExp(`^${ORIGIN}/reset#[A-Za-z0-9_-]{43}$`));
    expect(expiresAt).toBe("2026-09-15T02:00:00.000Z");
    const token = tokenOf(link);
    w.advance(23 * 3600 * 1000);
    const next = "another good password";
    expect((await w.device().call("POST", "/auth/reset", { token, password: next })).status).toBe(200);
    expect((await w.device().call("POST", "/auth/reset", { token, password: next })).status).toBe(400);
    expect((await w.device().call("POST", "/auth/sign-in", { email: sam.email, password: next })).status).toBe(200);
  });

  it("lets a reset link lapse after 24 hours", async () => {
    const w = world();
    const op = await owned(w);
    const sam = await join(w, op, "Sam");
    const { link } = await body<{ link: string }>(await op.call("POST", "/auth/people/reset", { id: sam.id }));
    w.advance(DAY + 1);
    expect((await w.device().call("POST", "/auth/reset", { token: tokenOf(link), password: "another good password" })).status).toBe(400);
  });

  it("is only the owner's: a person and a signed-out visitor get nothing", async () => {
    const w = world();
    const op = await owned(w);
    const sam = await join(w, op, "Sam");
    const routes: [string, string, unknown?][] = [
      ["POST", "/auth/people/invite", { firstName: "Eve" }], ["GET", "/auth/people"],
      ["POST", "/auth/people/remove", { id: sam.id }], ["POST", "/auth/people/reset", { id: sam.id }],
      ["POST", "/auth/people/withdraw", { id: "x" }],
    ];
    for (const [method, path, payload] of routes) {
      expect((await sam.guest.call(method, path, payload)).status, `${path} as a person`).toBe(403);
      expect((await w.device().call(method, path, payload)).status, `${path} signed out`).toBe(401);
    }
    expect(await w.store.deletion(sam.id)).toBeNull();
  });
});

describe("what a person sees", () => {
  it("is none of the owner's data, and lists no people", async () => {
    const w = world();
    const op = await owned(w);
    const made = await op.call("POST", "/api/ventures", { name: "Owner Secret Space" });
    expect(made.status).toBeLessThan(300);
    const sam = await join(w, op, "Sam");
    const seen = await (await sam.guest.call("GET", "/api/overview")).text();
    expect(seen).not.toContain("Owner Secret Space");
    expect(await w.store.people(sam.id)).toEqual({ people: [], invites: [] });
  });
});
