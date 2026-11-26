import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Reminder } from "../web/reminderEvent.js";
import { openLocalStore, type Store } from "../api/store.js";
import { LOCAL_OWNER, localIdentity } from "./identity.js";
import { localTick } from "./localTick.js";
import { applyMigrations, bundledMigrations } from "./migrate.js";
import { createSqlBinding, type SqlEngine } from "./sqlD1.js";
import { openSqliteEngine } from "./sqliteEngine.js";

const SYDNEY = "Australia/Sydney";
// 10:00 on 18 November in Sydney (UTC+11).
const TEN_AM = new Date("2026-11-17T23:00:00Z");

let engine: SqlEngine;
let store: Store;
let space: string;
let shown: Reminder[];

beforeEach(async () => {
  engine = await openSqliteEngine();
  await applyMigrations(engine, await bundledMigrations());
  store = openLocalStore(createSqlBinding(engine));
  await localIdentity({ store, timeZone: SYDNEY }).handle(new Request("https://vemi.test/auth/me"), () => undefined);
  const made = await store.create(LOCAL_OWNER, "ventures", { name: "Farm" });
  if (!made.ok) throw new Error(made.error);
  space = made.value.record.id;
  await store.setAppearance(LOCAL_OWNER, { taskReminders: true });
  shown = [];
});
afterEach(async () => {
  await engine.close();
});

async function task(title: string, remindAt: string): Promise<string> {
  const made = await store.create(LOCAL_OWNER, "tasks", { ventureId: space, title, remindAt });
  if (!made.ok) throw new Error(made.error);
  return made.value.record.id;
}

const tick = (now: Date, extra: Partial<Parameters<typeof localTick>[0]> = {}) =>
  localTick({ store, owner: LOCAL_OWNER, now, timeZone: SYDNEY, show: (r) => shown.push(r), ...extra });

describe("the reminders of the page", () => {
  it("shows a due reminder once, in the account's own zone", async () => {
    const id = await task("Water plants", "2026-11-18T09:30");
    await tick(TEN_AM);
    await tick(TEN_AM);
    await tick(new Date("2026-11-17T23:05:00Z"));
    expect(shown).toEqual([{ taskId: id, at: "2026-11-18T09:30" }]);
  });

  it("waits for its minute and is let go after a day", async () => {
    await task("Later", "2026-11-18T10:01");
    await task("Long gone", "2026-11-17T09:59");
    await tick(TEN_AM);
    expect(shown).toEqual([]);
    const later = await tick(new Date("2026-11-17T23:02:00Z"));
    expect(later).toBe(1);
    expect(shown.map((r) => r.at)).toEqual(["2026-11-18T10:01"]);
  });

  it("shows a snoozed reminder again at its new time", async () => {
    const id = await task("Call back", "2026-11-18T09:30");
    await tick(TEN_AM);
    const moved = await store.update(LOCAL_OWNER, "tasks", id, { remindAt: "2026-11-18T09:45" }, "2026-11-18");
    expect(moved.ok).toBe(true);
    await tick(TEN_AM);
    expect(shown.map((r) => r.at)).toEqual(["2026-11-18T09:30", "2026-11-18T09:45"]);
  });

  it("is silent for an archived task and a done one", async () => {
    const archived = await task("Archived", "2026-11-18T09:30");
    const done = await task("Done", "2026-11-18T09:31");
    await store.setArchived(LOCAL_OWNER, "tasks", archived, true);
    const finished = (await engine.run(`SELECT id FROM state WHERE venture_id = ? AND kind = 'finished'`, [space])).rows[0]?.[0] as string;
    const moved = await store.update(LOCAL_OWNER, "tasks", done, { stateId: finished }, "2026-11-18");
    expect(moved.ok).toBe(true);
    await tick(TEN_AM);
    expect(shown).toEqual([]);
  });

  it("is silent when the account has task reminders off, and inside quiet hours", async () => {
    await task("Quiet", "2026-11-18T09:30");
    await store.setAppearance(LOCAL_OWNER, { taskReminders: false });
    await tick(TEN_AM);
    expect(shown).toEqual([]);
    await store.setAppearance(LOCAL_OWNER, { taskReminders: true, quietFrom: "09:00", quietTo: "11:00" });
    await tick(TEN_AM);
    expect(shown).toEqual([]);
    // Quiet ends, and the reminder is still inside its day.
    await tick(new Date("2026-11-18T00:30:00Z"));
    expect(shown).toHaveLength(1);
  });

  it("does nothing once the page has been hidden longer than a reminder's window, and shows what is within it on return", async () => {
    await task("Within", "2026-11-18T09:45");
    await tick(TEN_AM, { hiddenSince: new Date("2026-11-17T22:00:00Z"), windowMinutes: 30 });
    expect(shown).toEqual([]);
    await tick(TEN_AM, { hiddenSince: new Date("2026-11-17T22:50:00Z"), windowMinutes: 30 });
    expect(shown).toHaveLength(1);
  });
});
