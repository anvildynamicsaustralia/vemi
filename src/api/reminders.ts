/**
 * The reminders job: each minute, tell each account's devices what is due in that account's
 * own day. Due task reminders go out one by one; inside the account's quiet hours they are
 * held and, once the quiet ends, go as one grouped message. The morning summary goes once a
 * day at the chosen time. Every send is written to `reminder_sent` after it lands, so a
 * minute that runs twice sends nothing twice, and a snooze (a new `remind_at`) sends again.
 *
 * One tick makes at most `MAX_SENDS` push requests. What does not fit stays unrecorded, so
 * the next minute finds it again and nothing is lost. Nothing here touches D1 directly.
 */
import { isEnvelopeShape, type PushPayload } from "@vemi/shared";
import type { Job } from "./tick.js";
import { openStore, type Store, type StoreEnv } from "./store.js";
import { sendPush, type PushResult, type PushVapid } from "./webPush.js";
import { vapidKeys } from "./vapid.js";

/** The most push requests one tick makes. */
export const MAX_SENDS = 40;

/** A due reminder older than this is let go rather than sent late. */
const LOOKBACK_MINUTES = 24 * 60;

/** What the job reads off the Worker's environment beyond the store. */
interface ReminderEnv extends StoreEnv {
  readonly TIME_ZONE?: string;
  readonly ORIGIN?: string;
  readonly VAPID_PUBLIC?: string;
  readonly VAPID_PRIVATE?: string;
}

export interface Local {
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** `HH:MM` */
  readonly time: string;
}

/** The wall clock in a zone. A zone this runtime does not know reads as `fallback`. */
export function localClock(at: Date, zone: string, fallback: string): Local {
  const read = (timeZone: string): Local => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
  };
  try {
    return read(zone);
  } catch {
    return read(fallback);
  }
}

/** A local wall time `YYYY-MM-DDTHH:MM` moved by whole minutes, by arithmetic on its digits. */
export function wallMinus(wall: string, minutes: number): string {
  const ms = Date.parse(`${wall}:00Z`) - minutes * 60_000;
  return new Date(ms).toISOString().slice(0, 16);
}

/** Whether a `HH:MM` falls in the quiet window, which may run across midnight. No window is never quiet. */
export function isQuiet(time: string, from: string | null, to: string | null): boolean {
  if (from === null || to === null || from === to) return false;
  return from < to ? time >= from && time < to : time >= from || time < to;
}

/** One send budget shared by everything a tick does. */
class Budget {
  readonly whole: number;
  constructor(public left: number) {
    this.whole = left;
  }
  /** Whether `n` more requests fit. A message to more devices than a whole tick allows still goes, alone. */
  fits(n: number): boolean {
    return this.left >= n || this.left === this.whole;
  }
  spend(n: number): void {
    this.left = Math.max(0, this.left - n);
  }
}

export interface Sender {
  readonly store: Store;
  readonly vapid: PushVapid;
  readonly post: typeof fetch;
  readonly now: Date;
  readonly budget: Budget;
}

/** Sends one payload to each of the account's devices. True when at least one took it. */
async function deliver(s: Sender, owner: string, payload: PushPayload): Promise<boolean> {
  const devices = await s.store.pushDevices(owner);
  let landed = false;
  for (const device of devices) {
    s.budget.spend(1);
    const result: PushResult = await sendPush(device, payload, s.vapid, s.now, s.post);
    if (result.kind === "sent") {
      landed = true;
      await s.store.pushWorked(owner, device.id);
    } else if (result.kind === "gone") {
      // The push service forgot this device. It is archived, not erased: turning reminders on
      // again from it brings it back. A `failed` one is kept and tried again next minute.
      await s.store.unsubscribePush(owner, device.endpoint);
    }
  }
  return landed;
}

const reminderCount = (n: number): string => `${n} reminders`;

/** What a push says when the title is not the server's to read. The device swaps in the real one. */
export const GENERIC_TITLE = "You have a reminder";

/**
 * How a task's title goes on a push. A plain account gets it as it always did. Any other
 * account gets no plaintext: the task's own title envelope rides as `sealedTitle` for the
 * device to open, and a title that is not an envelope (not sealed yet) is simply left out.
 */
function taskPayload(sealed: boolean, item: { readonly taskId: string; readonly title: string; readonly remindAt: string }): PushPayload {
  const tag = `task-${item.taskId}`;
  return sealed
    ? { kind: "task", title: GENERIC_TITLE, body: "", taskId: item.taskId, at: item.remindAt, tag, ...sealedOf(item.title) }
    : { kind: "task", title: item.title, body: "", taskId: item.taskId, at: item.remindAt, tag };
}

const sealedOf =(title: string): { readonly sealedTitle?: string } => (isEnvelopeShape(title) ? { sealedTitle: title } : {});

async function accountPass(s: Sender, account: Awaited<ReturnType<Store["reminderAccounts"]>>[number], fallbackZone: string): Promise<void> {
  const { owner, settings } = account;
  const sealed = account.encryption !== "off";
  const local = localClock(s.now, account.tz ?? fallbackZone, fallbackZone);
  const wall = `${local.date}T${local.time}`;
  if (isQuiet(local.time, settings.quietFrom, settings.quietTo)) return;
  const devices = await s.store.pushDevices(owner);
  if (devices.length === 0) return;
  const cost = devices.length;

  if (settings.taskReminders) {
    const due = await s.store.dueReminders(owner, wallMinus(wall, LOOKBACK_MINUTES), wall, 200);
    const held = due.filter((d) => isQuiet(d.remindAt.slice(11), settings.quietFrom, settings.quietTo));
    const prompt = due.filter((d) => !held.includes(d));
    for (const item of prompt) {
      if (!s.budget.fits(cost)) return;
      const payload = taskPayload(sealed, item);
      if (await deliver(s, owner, payload)) await s.store.recordReminderSent(owner, "task", item.taskId, item.remindAt);
    }
    if (held.length > 0 && s.budget.fits(cost)) {
      const first = held[0]!;
      const payload: PushPayload = held.length === 1
        ? taskPayload(sealed, first)
        : sealed
          ? { kind: "held", title: reminderCount(held.length), body: "", taskId: first.taskId, count: held.length, tag: "held", ...sealedOf(first.title) }
          : { kind: "held", title: reminderCount(held.length), body: first.title, count: held.length, tag: "held" };
      if (await deliver(s, owner, payload)) {
        for (const item of held) await s.store.recordReminderSent(owner, "task", item.taskId, item.remindAt);
      }
    }
  }

  if (settings.morningAt !== null && local.time >= settings.morningAt && s.budget.fits(cost)
    && !(await s.store.reminderWasSent(owner, "morning", "day", local.date))) {
    const today = (await s.store.today(owner, local.date)).tasks.filter((t) => t.stateKind !== "finished");
    // An empty day has nothing to say; the day is still marked so it is not asked again.
    const lead = today[0];
    if (lead === undefined || (await deliver(s, owner, sealed
      ? { kind: "morning", title: `${today.length} on today`, body: "", taskId: lead.id, count: today.length, tag: "morning", ...sealedOf(lead.title) }
      : { kind: "morning", title: `${today.length} on today`, body: lead.title, count: today.length, tag: "morning" }))) {
      await s.store.recordReminderSent(owner, "morning", "day", local.date);
    }
  }
}

export interface TickOptions {
  readonly now: Date;
  readonly timeZone: string;
  readonly vapid: () => Promise<PushVapid>;
  readonly post?: typeof fetch;
  readonly maxSends?: number;
}

/** One pass over every account. The job below is this with the Worker's own environment. */
export async function sendReminders(store: Store, options: TickOptions): Promise<void> {
  const accounts = await store.reminderAccounts();
  if (accounts.length === 0) return;
  const sender: Sender = {
    store, vapid: await options.vapid(), post: options.post ?? fetch, now: options.now,
    budget: new Budget(options.maxSends ?? MAX_SENDS),
  };
  for (const account of accounts) {
    if (sender.budget.left === 0) return;
    await accountPass(sender, account, options.timeZone);
  }
}

/** A test message to every device the account has. Counts how many took it. */
export async function sendTest(
  store: Store, owner: string, vapid: PushVapid, now: Date, post: typeof fetch = fetch,
): Promise<{ readonly devices: number; readonly sent: number }> {
  const devices = await store.pushDevices(owner);
  let sent = 0;
  for (const device of devices) {
    const payload: PushPayload = { kind: "test", title: "Reminders are on", body: "This is a test", tag: "test" };
    const result = await sendPush(device, payload, vapid, now, post);
    if (result.kind === "sent") {
      sent++;
      await store.pushWorked(owner, device.id);
    } else if (result.kind === "gone") {
      await store.unsubscribePush(owner, device.endpoint);
    }
  }
  return { devices: devices.length, sent };
}

export const remindersJob: Job = {
  name: "reminders",
  schedule: "* * * * *",
  async run(now, env) {
    const e = env as ReminderEnv;
    const store = openStore(env);
    await sendReminders(store, {
      now,
      timeZone: e.TIME_ZONE ?? "UTC",
      vapid: async () => ({
        ...(await vapidKeys(store, { publicKey: e.VAPID_PUBLIC, privateKey: e.VAPID_PRIVATE })),
        subject: e.ORIGIN ?? "https://localhost",
      }),
    });
  },
};
