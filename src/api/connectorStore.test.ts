import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** 0022_connector: codes, grants and the change log, through the store and a real D1. */

const CLIENT = "https://claude.example/client.json";
const REDIRECT = "https://claude.example/cb";

let t: TestDb;
let store: Store;
let now = new Date("2026-11-18T02:00:00Z");
const at = (minutes: number): string => new Date(now.getTime() + minutes * 60_000).toISOString();

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => now);
  await store.registerClient({ id: CLIENT, name: "Claude", redirectUris: [REDIRECT] });
});
afterAll(() => t.dispose());

let n = 0;
const sha = async (s: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function person(): Promise<string> {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash: "x", googleSub: null, confirmed: true })).toBe(true);
  return owner;
}

async function grant(owner: string, minutes = 60) {
  n += 1;
  const token = `access-secret-${n}`;
  const refresh = `refresh-secret-${n}`;
  const g = await store.issueGrant(owner, { clientId: CLIENT, tokenHash: await sha(token), refreshHash: await sha(refresh), expiresAt: at(minutes) });
  return { g, token, refresh };
}

const next = async (tag: string) => ({ tokenHash: await sha(`t-${tag}`), refreshHash: await sha(`r-${tag}`), expiresAt: at(60) });

describe("client", () => {
  it("is read back, and registering again replaces its addresses", async () => {
    expect((await store.client(CLIENT))?.redirectUris).toEqual([REDIRECT]);
    await store.registerClient({ id: CLIENT, name: "Claude", redirectUris: [REDIRECT, `${REDIRECT}2`] });
    expect((await store.client(CLIENT))?.redirectUris).toHaveLength(2);
    expect(await store.client("https://nobody.example/c.json")).toBeNull();
  });
});

describe("codes", () => {
  const code = async (owner: string, minutes = 10) => {
    n += 1;
    const hash = await sha(`code-${n}`);
    await store.putCode(owner, { hash, clientId: CLIENT, challenge: "chal", redirectUri: REDIRECT, expiresAt: at(minutes) });
    return hash;
  };

  it("exchanges once and then never again", async () => {
    const owner = await person();
    const hash = await code(owner);
    expect(await store.takeCode(hash)).toMatchObject({ owner, clientId: CLIENT, challenge: "chal", redirectUri: REDIRECT });
    expect(await store.takeCode(hash)).toBeNull();
  });

  it("answers nothing once expired", async () => {
    const hash = await code(await person(), -1);
    expect(await store.takeCode(hash)).toBeNull();
    expect(await store.takeCode(hash)).toBeNull();
  });

  it("stores only the hash", async () => {
    const owner = await person();
    const hash = await code(owner);
    const rows = JSON.stringify((await t.db.prepare(`SELECT * FROM connector_code WHERE owner = ?`).bind(owner).all()).results);
    expect(rows).toContain(hash);
    expect(rows).not.toContain(`code-${n}`);
  });
});

describe("grants", () => {
  it("stores only hashes and reads by token hash", async () => {
    const owner = await person();
    const { g, token, refresh } = await grant(owner);
    const rows = JSON.stringify((await t.db.prepare(`SELECT * FROM connector_grant WHERE id = ?`).bind(g.id).all()).results);
    expect(rows).not.toContain(token);
    expect(rows).not.toContain(refresh);
    expect(rows).toContain(await sha(token));
    const read = await store.grantByToken(await sha(token));
    expect(read).toMatchObject({ id: g.id, owner, clientId: CLIENT, clientName: "Claude" });
    expect(JSON.stringify(read)).not.toMatch(/hash/i);
    expect(await store.grantByToken(await sha("not-a-token"))).toBeNull();
  });

  it("notes when it was last used", async () => {
    const { g, token } = await grant(await person());
    expect(g.lastUsedAt).toBeNull();
    expect((await store.grantByToken(await sha(token)))?.lastUsedAt).toBe(now.toISOString());
  });

  it("stops answering when it expires", async () => {
    const { token } = await grant(await person(), -1);
    expect(await store.grantByToken(await sha(token))).toBeNull();
  });

  it("rotates on refresh: the old token and the old refresh stop working", async () => {
    const { g, token, refresh } = await grant(await person());
    const rotated = await store.rotateGrant(await sha(refresh), CLIENT, await next("2"));
    expect(rotated?.id).toBe(g.id);
    expect(await store.grantByToken(await sha(token))).toBeNull();
    expect((await store.grantByToken(await sha("t-2")))?.id).toBe(g.id);
    expect(await store.rotateGrant(await sha(refresh), CLIENT, await next("3"))).toBeNull();
    expect(await store.grantByToken(await sha("t-3"))).toBeNull();
  });

  it("refuses to rotate a revoked grant", async () => {
    const owner = await person();
    const { g, refresh } = await grant(owner);
    expect(await store.revokeGrant(owner, g.id)).toBe(true);
    expect(await store.rotateGrant(await sha(refresh), CLIENT, await next("4"))).toBeNull();
  });

  it("revokes at once, and a second revoke says nothing was left to do", async () => {
    const owner = await person();
    const { g, token } = await grant(owner);
    expect(await store.revokeGrant(owner, g.id)).toBe(true);
    expect(await store.grantByToken(await sha(token))).toBeNull();
    expect(await store.revokeGrant(owner, g.id)).toBe(false);
    expect(await store.grants(owner)).toEqual([]);
  });

  it("lists a person's live grants without any hash", async () => {
    const owner = await person();
    const a = await grant(owner);
    const b = await grant(owner);
    const list = await store.grants(owner);
    expect(list.map((x) => x.id).sort()).toEqual([a.g.id, b.g.id].sort());
    expect(JSON.stringify(list)).not.toMatch(/hash/i);
  });

  it("is invisible to a second account: no list, no revoke", async () => {
    const [one, two] = [await person(), await person()];
    const { g, token } = await grant(one);
    expect(await store.grants(two)).toEqual([]);
    expect(await store.revokeGrant(two, g.id)).toBe(false);
    expect((await store.grantByToken(await sha(token)))?.owner).toBe(one);
    expect(await store.grants(one)).toHaveLength(1);
  });
});

describe("purge", () => {
  it("removes expired codes and grants revoked over 30 days ago, and keeps the rest", async () => {
    const was = now;
    try {
      const owner = await person();
      const gone = await grant(owner);
      await store.revokeGrant(owner, gone.g.id);
      now = new Date(was.getTime() + 31 * 24 * 3_600_000);
      const live = await grant(owner);
      const recent = await grant(owner);
      await store.revokeGrant(owner, recent.g.id);
      await store.putCode(owner, { hash: await sha("old-code"), clientId: CLIENT, challenge: "c", redirectUri: REDIRECT, expiresAt: at(-5) });
      await store.putCode(owner, { hash: await sha("new-code"), clientId: CLIENT, challenge: "c", redirectUri: REDIRECT, expiresAt: at(5) });
      const purged = await store.purgeConnector();
      expect(purged.codes).toBeGreaterThanOrEqual(1);
      expect(purged.grants).toBeGreaterThanOrEqual(1);
      expect(await store.takeCode(await sha("old-code"))).toBeNull();
      expect(await store.takeCode(await sha("new-code"))).not.toBeNull();
      expect((await store.grants(owner)).map((x) => x.id)).toEqual([live.g.id]);
      expect(await t.db.prepare(`SELECT id FROM connector_grant WHERE id = ?`).bind(gone.g.id).first()).toBeNull();
      expect(await t.db.prepare(`SELECT id FROM connector_grant WHERE id = ?`).bind(recent.g.id).first()).not.toBeNull();
    } finally {
      now = was;
      await store.registerClient({ id: CLIENT, name: "Claude", redirectUris: [REDIRECT] });
    }
  });
});

describe("changes", () => {
  const WEEK = -60 * 24 * 7;

  it("records, lists newest first, and marks undone, for the owner only", async () => {
    const [one, two] = [await person(), await person()];
    const { g } = await grant(one);
    const first = await store.recordChange(one, { grantId: g.id, clientName: "Claude", tool: "update_task", kind: "tasks", recordId: "t1", before: { title: "old" } });
    now = new Date(now.getTime() + 1000);
    const added = await store.recordChange(one, { grantId: g.id, clientName: "Claude", tool: "add_task", kind: "tasks", recordId: "t2", before: null });
    const list = await store.changes(one, at(WEEK));
    expect(list.map((c) => c.id)).toEqual([added.id, first.id]);
    expect(list[1]?.before).toEqual({ title: "old" });
    expect(list[0]?.before).toBeNull();
    expect(await store.changes(two, at(WEEK))).toEqual([]);
    expect(await store.markChangeUndone(two, first.id)).toBe(false);
    expect(await store.markChangeUndone(one, first.id)).toBe(true);
    expect(await store.markChangeUndone(one, first.id)).toBe(false);
    expect((await store.changes(one, at(WEEK))).find((c) => c.id === first.id)?.undoneAt).not.toBeNull();
  });

  it("leaves out changes older than the cutoff", async () => {
    const owner = await person();
    const { g } = await grant(owner);
    await store.recordChange(owner, { grantId: g.id, clientName: "Claude", tool: "add_task", kind: "tasks", recordId: "t9", before: null });
    expect(await store.changes(owner, at(60))).toEqual([]);
  });
});

describe("refresh lifetime", () => {
  const DAY_MINUTES = 60 * 24;

  it("a refresh token is dead 30 days after the last rotation, and rotating starts the 30 days again", async () => {
    const was = now;
    try {
      const { g, refresh } = await grant(await person());
      now = new Date(was.getTime() + 29 * DAY_MINUTES * 60_000);
      const again = await store.rotateGrant(await sha(refresh), CLIENT, await next("life-1"));
      expect(again?.id).toBe(g.id);
      now = new Date(was.getTime() + 58 * DAY_MINUTES * 60_000);
      const second = await store.rotateGrant(await sha("r-life-1"), CLIENT, await next("life-2"));
      expect(second?.id).toBe(g.id);
      now = new Date(was.getTime() + 89 * DAY_MINUTES * 60_000);
      expect(await store.rotateGrant(await sha("r-life-2"), CLIENT, await next("life-3"))).toBeNull();
      expect(await store.grantByToken(await sha("t-life-3"))).toBeNull();
    } finally {
      now = was;
    }
  });

  it("a refresh named by the wrong app changes nothing, so the right app can still use it", async () => {
    const { g, refresh } = await grant(await person());
    expect(await store.rotateGrant(await sha(refresh), "https://other.example/client.json", await next("wrong"))).toBeNull();
    expect(await store.grantByToken(await sha("t-wrong"))).toBeNull();
    expect((await store.rotateGrant(await sha(refresh), CLIENT, await next("right")))?.id).toBe(g.id);
  });
});

describe("purge by lifetime", () => {
  it("removes a grant whose refresh ran out, keeps a revoked one for 30 days, then removes it, and removes unused apps after a day", async () => {
    const was = now;
    const owner = await person();
    const old = await grant(owner);
    const revoked = await grant(owner);
    await store.revokeGrant(owner, revoked.g.id);
    await store.registerClient({ id: "https://unused.example/client.json", name: "Unused", redirectUris: [REDIRECT] });
    try {
      now = new Date(was.getTime() + 25 * 60 * 60_000);
      let purged = await store.purgeConnector();
      expect(purged.clients).toBe(1);
      expect(await store.client("https://unused.example/client.json")).toBeNull();
      expect(await store.client(CLIENT)).not.toBeNull();
      expect(purged.grants).toBe(0);

      now = new Date(was.getTime() + 29 * 24 * 3_600_000);
      expect((await store.purgeConnector()).grants).toBe(0);

      now = new Date(was.getTime() + 31 * 24 * 3_600_000);
      purged = await store.purgeConnector();
      expect(purged.grants).toBeGreaterThanOrEqual(2);
      expect(await store.rotateGrant(await sha(old.refresh), CLIENT, await next("gone"))).toBeNull();
    } finally {
      now = was;
      await store.registerClient({ id: CLIENT, name: "Claude", redirectUris: [REDIRECT] });
    }
  });
});
