import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** GET /api/filters/dates: the two lists that need today, worked out in one place. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";
// 13:00 on Wednesday 2026-11-18 in Sydney, 02:00 the same day in UTC; the coming Sunday is 2026-11-22.
const NOW = new Date("2026-11-18T02:00:00Z");

let t: TestDb;
let store: Store;
let app: App;
let passwordHash: string;

function must<T>(o: Outcome<T>): T {
  if (!o.ok) throw new Error(o.error);
  return o.value;
}

beforeAll(async () => {
  t = await testDb();
  passwordHash = await hashPassword(PASSWORD);
  store = openStore({ DB: t.db }, () => NOW);
  app = createApp({
    store, now: () => NOW, origin: ORIGIN, timeZone: "Australia/Sydney",
    identity: accountIdentity({
      store, now: () => NOW, origin: ORIGIN, owner: "the-operator", operatorEmail: "",
      sessionSecret: "session-secret", google: null,
      fetch: async () => { throw new Error("a test reached the network"); },
    }),
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
});
afterAll(() => t.dispose());

async function account() {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
  const states = must(await store.list(owner, "states", { venture }));
  const finished = states.find((s) => s.kind === "finished")!.id;
  const res = await app(new Request(`${ORIGIN}/auth/sign-in`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: `${owner}@example.test`, password: PASSWORD }),
  }), () => {});
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { owner, venture, finished, cookie };
}
type Account = Awaited<ReturnType<typeof account>>;

async function task(a: Account, title: string, fields: Record<string, unknown> = {}): Promise<string> {
  return must(await store.create(a.owner, "tasks", { id: crypto.randomUUID(), ventureId: a.venture, title, ...fields } as never)).record.id;
}

interface Answer { on: string; before: { id: string; title: string }[]; week: { id: string; title: string }[] }
async function dates(a: Account, query = ""): Promise<Answer> {
  const res = await app(new Request(`${ORIGIN}/api/filters/dates${query}`, { headers: { origin: ORIGIN, cookie: a.cookie } }), () => {});
  expect(res.status).toBe(200);
  return (await res.json()) as Answer;
}
const titles = (rows: { title: string }[]): string[] => rows.map((r) => r.title).sort();

describe("GET /api/filters/dates", () => {
  it("lists what is due before today and what is due from today to Sunday", async () => {
    const a = await account();
    await task(a, "early", { dueOn: "2026-11-17" });
    await task(a, "today", { dueOn: "2026-11-18" });
    await task(a, "sunday", { dueOn: "2026-11-22" });
    await task(a, "monday", { dueOn: "2026-11-23" });
    await task(a, "undated");
    const got = await dates(a);
    expect(got.on).toBe("2026-11-18");
    expect(titles(got.before)).toEqual(["early"]);
    expect(titles(got.week)).toEqual(["sunday", "today"]);
  });

  it("leaves out finished and archived tasks", async () => {
    const a = await account();
    await task(a, "done before", { dueOn: "2026-11-01", stateId: a.finished });
    await task(a, "done soon", { dueOn: "2026-11-19", stateId: a.finished });
    const gone = await task(a, "gone before", { dueOn: "2026-11-01" });
    const goneSoon = await task(a, "gone soon", { dueOn: "2026-11-19" });
    await task(a, "kept", { dueOn: "2026-11-01" });
    must(await store.setArchived(a.owner, "tasks", gone, true));
    must(await store.setArchived(a.owner, "tasks", goneSoon, true));
    const got = await dates(a);
    expect(titles(got.before)).toEqual(["kept"]);
    expect(got.week).toEqual([]);
  });

  it("never shows a second account's tasks", async () => {
    const a = await account();
    const b = await account();
    await task(b, "theirs before", { dueOn: "2026-11-01" });
    await task(b, "theirs soon", { dueOn: "2026-11-19" });
    await task(a, "mine", { dueOn: "2026-11-19" });
    const got = await dates(a);
    expect(got.before).toEqual([]);
    expect(titles(got.week)).toEqual(["mine"]);
  });

  it("ends the week on Sunday, and on a Sunday the week is that day alone", async () => {
    const a = await account();
    await task(a, "sat", { dueOn: "2026-11-21" });
    await task(a, "sun", { dueOn: "2026-11-22" });
    await task(a, "mon", { dueOn: "2026-11-23" });
    const sunday = await dates(a, "?on=2026-11-22");
    expect(sunday.on).toBe("2026-11-22");
    expect(titles(sunday.before)).toEqual(["sat"]);
    expect(titles(sunday.week)).toEqual(["sun"]);
    const saturday = await dates(a, "?on=2026-11-21");
    expect(titles(saturday.week)).toEqual(["sat", "sun"]);
  });

  it("turns the day over in the zone the page names", async () => {
    const a = await account();
    // 02:00 UTC on the 18th is 18:00 on the 17th in Los Angeles.
    expect((await dates(a, "?tz=America/Los_Angeles")).on).toBe("2026-11-17");
    expect((await dates(a)).on).toBe("2026-11-18");
  });

  it("refuses a day that is not a date", async () => {
    const a = await account();
    const res = await app(new Request(`${ORIGIN}/api/filters/dates?on=soon`, { headers: { origin: ORIGIN, cookie: a.cookie } }), () => {});
    expect(res.status).toBe(400);
  });

  it("is read only", async () => {
    const a = await account();
    const res = await app(new Request(`${ORIGIN}/api/filters/dates`, {
      method: "POST", headers: { origin: ORIGIN, cookie: a.cookie, "content-type": "application/json" }, body: "{}",
    }), () => {});
    expect(res.status).toBe(405);
  });
});
