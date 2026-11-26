import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PushBrowser, PushCalls } from "../pushDevice.js";
import { AppContext, type AppActions } from "./appContext.js";
import { FirstRunHome } from "./FirstRunHome.js";
import { FirstRunRemind, REMIND_DEFAULTS, remindTurnOn } from "./FirstRunRemind.js";

const app = { notify: () => undefined } as unknown as AppActions;
const inApp = (node: React.ReactNode): string =>
  renderToStaticMarkup(<AppContext.Provider value={app}>{node}</AppContext.Provider>);

const browser = (over: Partial<PushBrowser> = {}): PushBrowser => ({
  ua: "Mozilla/5.0 Chrome/120 Windows",
  standalone: false,
  supported: true,
  zone: "Australia/Sydney",
  permission: () => "default",
  requestPermission: () => Promise.resolve("granted"),
  current: () => Promise.resolve(null),
  subscribe: () => Promise.resolve({
    endpoint: "e",
    toJSON: () => ({ endpoint: "e", keys: {} }),
    unsubscribe: () => Promise.resolve(true),
  }),
  ...over,
}) as PushBrowser;
const calls = (): PushCalls => ({
  key: () => Promise.resolve("AAAA"),
  subscribe: vi.fn(() => Promise.resolve()),
  unsubscribe: () => Promise.resolve(),
});

describe("the reminder card", () => {
  const out = inApp(<FirstRunRemind onDone={() => undefined} />);

  it("is the mock's card in the account's words, preset to the mock's choices", () => {
    expect(out).toContain("Want VEMI to remind you?");
    expect(out).toContain("Morning summary");
    expect(out).toContain("Reminders on tasks");
    expect(out).toContain("Quiet hours");
    expect(out).toContain("9 pm to 7 am");
    expect(out).toContain(">Turn on<");
    expect(out).toContain(">Not now<");
    expect(REMIND_DEFAULTS).toEqual({ morningAt: "07:00", taskReminders: true, quietFrom: "21:00", quietTo: "07:00" });
  });

  it("has no instruction sentence and no em-dash", () => {
    expect(out).not.toContain(String.fromCharCode(0x2014));
    expect(out).not.toContain("add VEMI to your home screen first");
  });
});

describe("Turn on", () => {
  it("saves the account choices first, then asks the device", async () => {
    const order: string[] = [];
    const save = vi.fn(() => { order.push("save"); return Promise.resolve(); });
    const c = calls();
    const state = await remindTurnOn(
      REMIND_DEFAULTS,
      save,
      browser({ requestPermission: () => { order.push("ask"); return Promise.resolve("granted"); } }),
      c,
    );
    expect(state).toBe("on");
    expect(order).toEqual(["save", "ask"]);
    expect(save).toHaveBeenCalledWith(REMIND_DEFAULTS);
    expect(c.subscribe).toHaveBeenCalledOnce();
  });

  it("in local mode saves the choices and never asks the browser or the push service", async () => {
    const save = vi.fn(() => Promise.resolve());
    const ask = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    const c = calls();
    const state = await remindTurnOn(REMIND_DEFAULTS, save, browser({ requestPermission: ask }), c, true);
    expect(state).toBe("on");
    expect(save).toHaveBeenCalledWith(REMIND_DEFAULTS);
    expect(ask).not.toHaveBeenCalled();
    expect(c.subscribe).not.toHaveBeenCalled();
  });

  it("keeps the account choices when the device is denied", async () => {
    const save = vi.fn(() => Promise.resolve());
    const state = await remindTurnOn(REMIND_DEFAULTS, save, browser({ requestPermission: () => Promise.resolve("denied") }), calls());
    expect(state).toBe("denied");
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps the account choices on an iPhone that is not on the home screen", async () => {
    const save = vi.fn(() => Promise.resolve());
    const state = await remindTurnOn(REMIND_DEFAULTS, save, browser({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" }), calls());
    expect(state).toBe("install");
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps the account choices where the browser cannot show reminders", async () => {
    const save = vi.fn(() => Promise.resolve());
    const state = await remindTurnOn(REMIND_DEFAULTS, save, browser({ supported: false }), calls());
    expect(state).toBe("unsupported");
    expect(save).toHaveBeenCalledOnce();
  });
});

describe("the home screen card", () => {
  it("offers Install for a browser's own install, with Not now", () => {
    const out = inApp(<FirstRunHome offer="button" onDone={() => undefined} />);
    expect(out).toContain("Add VEMI to your home screen");
    expect(out).toContain(">Install<");
    expect(out).toContain(">Not now<");
  });

  it("gives the platform's own steps on an iPhone, with no button", () => {
    const out = inApp(<FirstRunHome offer="ios" onDone={() => undefined} />);
    expect(out).toContain("In Safari, tap Share, then Add to Home Screen.");
    expect(out).not.toContain(">Install<");
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });
});
