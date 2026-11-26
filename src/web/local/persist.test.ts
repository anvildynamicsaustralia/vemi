import { describe, expect, it } from "vitest";
import { askToKeep, KEEPING_MAY_CLEAR, KEEPING_NOTHING, keepingRule, keepingSeen, markKeepingSeen, platformOf, rememberedAnswer } from "./persist.js";
import type { StorageLike } from "./storage.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

function memory(): StorageLike & { fail?: boolean } {
  const map = new Map<string, string>();
  const store: StorageLike & { fail?: boolean } = {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => { if (store.fail) throw new Error("blocked"); return map.get(k) ?? null; },
    setItem: (k, v) => { if (store.fail) throw new Error("blocked"); map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
  return store;
}

describe("platformOf", () => {
  it("tells iPhone, iPad, Safari and the rest apart", () => {
    expect(platformOf({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe("ios-safari");
    expect(platformOf({ userAgent: MAC_SAFARI, maxTouchPoints: 5 })).toBe("ios-safari");
    expect(platformOf({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toBe("safari");
    expect(platformOf({ userAgent: CHROME, maxTouchPoints: 0 })).toBe("other");
    expect(platformOf({ userAgent: FIREFOX, maxTouchPoints: 0 })).toBe("other");
  });
});

describe("keepingRule", () => {
  const base = { persisted: true, volatile: false, standalone: false, platform: "other" } as const;

  it("says nothing extra where the browser said the data is safe", () => {
    expect(keepingRule(base)).toBe("none");
  });

  it("says nothing extra in the installed app that did not refuse", () => {
    expect(keepingRule({ ...base, persisted: null, standalone: true, platform: "ios-safari" })).toBe("none");
    expect(keepingRule({ ...base, persisted: true, standalone: true, platform: "ios-safari" })).toBe("none");
  });

  it("warns when the browser answered persist() false", () => {
    expect(keepingRule({ ...base, persisted: false })).toBe("may-clear");
    expect(keepingRule({ ...base, persisted: false, standalone: true })).toBe("may-clear");
  });

  it("warns in Safari outside the home-screen app, on iPhone, iPad and the desk", () => {
    expect(keepingRule({ ...base, platform: "safari" })).toBe("may-clear");
    expect(keepingRule({ ...base, platform: "ios-safari" })).toBe("may-clear");
  });

  it("warns when the browser has no storage answer at all", () => {
    expect(keepingRule({ ...base, persisted: null })).toBe("may-clear");
  });

  it("says nothing is kept when the database fell back to memory, whatever else is true", () => {
    expect(keepingRule({ ...base, volatile: true })).toBe("nothing-kept");
    expect(keepingRule({ ...base, volatile: true, persisted: false, platform: "safari" })).toBe("nothing-kept");
    expect(keepingRule({ ...base, volatile: true, standalone: true })).toBe("nothing-kept");
  });

  it("does not guess volatile before any tab has said", () => {
    expect(keepingRule({ ...base, volatile: null })).toBe("none");
  });
});

describe("the lines", () => {
  it("are plain and carry no em-dash", () => {
    expect(KEEPING_MAY_CLEAR).toBe("This browser may clear VEMI's data if you do not use it for a while. Export now and then.");
    expect(KEEPING_NOTHING.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(KEEPING_NOTHING).toMatch(/nothing/i);
  });
});

describe("askToKeep", () => {
  it("asks the browser and keeps the answer", async () => {
    const store = memory();
    expect(await askToKeep({ storage: { persist: async () => false } }, store)).toBe(false);
    expect(rememberedAnswer(store)).toBe(false);
    expect(await askToKeep({ storage: { persist: async () => true } }, store)).toBe(true);
    expect(rememberedAnswer(store)).toBe(true);
  });

  it("answers null, and keeps nothing, when navigator.storage is missing", async () => {
    const store = memory();
    store.setItem("vemi:keeping:persisted:v1", "no");
    expect(await askToKeep({}, store)).toBeNull();
    expect(await askToKeep({ storage: {} }, store)).toBeNull();
    expect(rememberedAnswer(store)).toBeNull();
  });

  it("answers null when persist() throws, and still answers when storage is blocked", async () => {
    expect(await askToKeep({ storage: { persist: async () => { throw new Error("no"); } } }, memory())).toBeNull();
    const blocked = memory();
    blocked.fail = true;
    expect(await askToKeep({ storage: { persist: async () => true } }, blocked)).toBe(true);
    expect(rememberedAnswer(blocked)).toBeNull();
  });
});

describe("seen once", () => {
  it("is false until marked, then true", () => {
    const store = memory();
    expect(keepingSeen(store)).toBe(false);
    markKeepingSeen(store);
    expect(keepingSeen(store)).toBe(true);
  });

  it("is false and silent when storage is blocked", () => {
    const blocked = memory();
    blocked.fail = true;
    expect(() => markKeepingSeen(blocked)).not.toThrow();
    expect(keepingSeen(blocked)).toBe(false);
  });
});
