import { describe, expect, it } from "vitest";
import { deviceLabel, deviceState, keyBytes, turnOff, turnOn, type PushBrowser, type PushCalls, type Subscribed } from "./pushDevice.js";

const KEY = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";

function browser(over: Partial<PushBrowser> = {}) {
  const log: string[] = [];
  let subscription: Subscribed | null = null;
  const b: PushBrowser = {
    ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36",
    standalone: false,
    supported: true,
    zone: "Australia/Sydney",
    permission: () => "default",
    requestPermission: async () => { log.push("ask"); return "granted"; },
    current: async () => subscription,
    subscribe: async (bytes) => {
      log.push(`subscribe ${bytes.length}`);
      subscription = {
        endpoint: "https://push.example/abc",
        toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }),
        unsubscribe: async () => { log.push("browser unsubscribe"); subscription = null; return true; },
      };
      return subscription;
    },
    ...over,
  };
  const calls: PushCalls = {
    key: async () => KEY,
    subscribe: async (body) => { log.push(`save ${JSON.stringify(body)}`); },
    unsubscribe: async (endpoint) => { log.push(`forget ${endpoint}`); },
  };
  return { b, calls, log };
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

describe("deviceState", () => {
  it("is off on a browser that can, before it was asked", async () => {
    expect(await deviceState(browser().b)).toBe("off");
  });
  it("says a refused permission", async () => {
    expect(await deviceState(browser({ permission: () => "denied" }).b)).toBe("denied");
  });
  it("sends an iPhone outside the home screen app to the steps", async () => {
    expect(await deviceState(browser({ ua: IPHONE, supported: false }).b)).toBe("install");
  });
  it("lets an iPhone in the home screen app turn them on", async () => {
    expect(await deviceState(browser({ ua: IPHONE, standalone: true }).b)).toBe("off");
  });
  it("says so where the browser cannot", async () => {
    expect(await deviceState(browser({ supported: false }).b)).toBe("unsupported");
  });
  it("is on once granted and subscribed", async () => {
    const { b, calls } = browser();
    await turnOn(b, calls);
    expect(await deviceState({ ...b, permission: () => "granted" })).toBe("on");
  });
  it("is off when granted but nothing is subscribed", async () => {
    expect(await deviceState(browser({ permission: () => "granted" }).b)).toBe("off");
  });
});

describe("turnOn", () => {
  it("asks permission, subscribes with the API key, and saves the label and zone", async () => {
    const { b, calls, log } = browser();
    expect(await turnOn(b, calls)).toBe("on");
    expect(log[0]).toBe("ask");
    expect(log[1]).toBe("subscribe 65");
    const saved = JSON.parse(log[2]!.slice(5)) as Record<string, unknown>;
    expect(saved).toMatchObject({ endpoint: "https://push.example/abc", tz: "Australia/Sydney", label: "Chrome on Windows" });
  });
  it("saves nothing and subscribes to nothing when permission is refused", async () => {
    const { b, calls, log } = browser({ requestPermission: async () => "denied" });
    expect(await turnOn(b, calls)).toBe("denied");
    expect(log).toEqual([]);
  });
  it("stays off when the question is dismissed", async () => {
    const { b, calls } = browser({ requestPermission: async () => "default" });
    expect(await turnOn(b, calls)).toBe("off");
  });
  it("lets the browser go again when the Worker would not keep the subscription", async () => {
    const { b, calls, log } = browser();
    await expect(turnOn(b, { ...calls, subscribe: async () => { throw new Error("no"); } })).rejects.toThrow("no");
    expect(log).toContain("browser unsubscribe");
  });
});

describe("turnOff", () => {
  it("tells the Worker, then lets the browser go", async () => {
    const { b, calls, log } = browser();
    await turnOn(b, calls);
    log.length = 0;
    await turnOff(b, calls);
    expect(log).toEqual(["forget https://push.example/abc", "browser unsubscribe"]);
  });
  it("does nothing with no subscription", async () => {
    const { b, calls, log } = browser();
    await turnOff(b, calls);
    expect(log).toEqual([]);
  });
});

describe("helpers", () => {
  it("reads the public key as bytes", () => {
    expect(keyBytes(KEY).length).toBe(65);
    expect(keyBytes(KEY)[0]).toBe(4);
  });
  it("names a device by what it is", () => {
    expect(deviceLabel(IPHONE)).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile")).toBe("Chrome on Android");
    expect(deviceLabel("Mozilla/5.0 (Macintosh) Version/17 Safari/605")).toBe("Safari on Mac");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux) Firefox/130")).toBe("Firefox on Linux");
    expect(deviceLabel("")).toBe("This device");
  });
});
