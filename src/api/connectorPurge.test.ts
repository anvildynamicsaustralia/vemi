import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectorPurgeJob } from "./connectorPurge.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { jobs, tick } from "./tick.js";

/** The daily connector purge: registered on the one cron, and doing what the store says. */

const DAY = 86_400_000;
const T0 = new Date("2026-11-18T03:30:00Z");

let t: TestDb;
let clock = T0;
let store: Store;
let n = 0;

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => clock);
});
afterAll(() => t.dispose());

const sha = async (s: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function person(): Promise<string> {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash: "x", googleSub: null, confirmed: true })).toBe(true);
  return owner;
}

async function grantFor(owner: string, clientId: string) {
  n += 1;
  await store.registerClient({ id: clientId, name: "App", redirectUris: ["https://app.example/cb"] });
  const refresh = `refresh-${n}`;
  const g = await store.issueGrant(owner, {
    clientId, tokenHash: await sha(`access-${n}`), refreshHash: await sha(refresh), expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(),
  });
  return { g, refresh };
}

describe("the daily purge job", () => {
  it("is registered once, daily, on the shared tick", () => {
    expect(jobs).toContain(connectorPurgeJob);
    expect(connectorPurgeJob.schedule).toBe("30 3 * * *");
    expect(jobs.filter((j) => j.name === "connector-purge")).toHaveLength(1);
  });

  it("runs at 03:30 UTC through the tick and removes what is spent, keeping the rest", async () => {
    const owner = await person();
    clock = T0;
    const rotatedLater = await grantFor(owner, "https://live.example/client.json");
    const neverRotated = await grantFor(owner, "https://unrotated.example/client.json");
    const revokedOld = await grantFor(owner, "https://revoked-old.example/client.json");
    await store.revokeGrant(owner, revokedOld.g.id);

    clock = new Date(T0.getTime() + 20 * DAY);
    const rotated = await store.rotateGrant(await sha(rotatedLater.refresh), "https://live.example/client.json", {
      tokenHash: await sha("t2"), refreshHash: await sha("r2"), expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(),
    });
    expect(rotated?.id).toBe(rotatedLater.g.id);

    clock = new Date(T0.getTime() + 31 * DAY);
    const revokedNew = await grantFor(owner, "https://revoked-new.example/client.json");
    await store.revokeGrant(owner, revokedNew.g.id);
    const ids = async (): Promise<string[]> =>
      (await t.db.prepare(`SELECT id FROM connector_grant WHERE owner = ?`).bind(owner).all<{ id: string }>()).results.map((r) => r.id).sort();

    const day = (h: number, m: number): Date => new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate(), h, m));
    await tick(day(3, 0), { DB: t.db }, [connectorPurgeJob]);
    expect(await ids()).toHaveLength(4);

    await tick(day(3, 30), { DB: t.db }, [connectorPurgeJob]);
    expect(await ids()).toEqual([rotatedLater.g.id, revokedNew.g.id].sort());
    expect(neverRotated.g.id).not.toBe(rotatedLater.g.id);
  });

  it("is a no-op that does not throw on an empty database", async () => {
    await expect(connectorPurgeJob.run(clock, { DB: t.db })).resolves.toBeUndefined();
  });
});
