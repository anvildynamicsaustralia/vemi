import { afterEach, describe, expect, it, vi } from "vitest";
import { groupingIn, rememberGrouping, savedGrouping, storedGroupings } from "./boardMemory.js";

const KEY = "vemi:board-group:v1";

/** Storage that behaves, so a test can say what was written as well as what was read. */
function shelf(start: Record<string, string> = {}) {
  const held = new Map(Object.entries(start));
  return {
    raw: (): string | null => held.get(KEY) ?? null,
    store: {
      getItem: (key: string): string | null => held.get(key) ?? null,
      setItem: (key: string, value: string): void => { held.set(key, value); },
    },
  };
}

/** Storage that refuses, the way a locked-down browser does. */
const refuses = {
  getItem: (): string => { throw new Error("no storage here"); },
  setItem: (): void => { throw new Error("no storage here"); },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storedGroupings", () => {
  it("reads the groupings a good value holds", () => {
    expect({ ...storedGroupings(`{"bds":"project","nd":"state"}`) }).toEqual({ bds: "project", nd: "state" });
  });

  it("answers with nothing, and never throws, whatever the value turns out to be", () => {
    for (const raw of [null, "", "{", "not json", "null", "7", `"state"`, "true", `["state"]`, `[{"bds":"tag"}]`]) {
      expect({ ...storedGroupings(raw) }).toEqual({});
    }
  });

  it("drops an entry that does not name a grouping this build has", () => {
    const held = storedGroupings(`{"bds":"project","old":"milestone","tag":"tag","prio":"priority","nested":{"x":1},"n":7,"gone":null}`);
    expect({ ...held }).toEqual({ bds: "project" });
  });

  it("keeps a hand-edited __proto__ as an ordinary entry, so nothing reads back off Object", () => {
    const held = storedGroupings(`{"__proto__":"project"}`);
    expect(Object.getPrototypeOf(held)).toBeNull();
    expect(groupingIn(`{"__proto__":"project"}`, "constructor")).toBe("state");
    expect(groupingIn(`{"__proto__":"project"}`, "toString")).toBe("state");
  });
});

describe("groupingIn", () => {
  it("is the venture's own choice", () => {
    expect(groupingIn(`{"bds":"state","nd":"project"}`, "nd")).toBe("project");
  });

  it("is state for a venture nothing has been chosen for, and for a value that says nothing", () => {
    expect(groupingIn(`{"bds":"project"}`, "nd")).toBe("state");
    expect(groupingIn(null, "bds")).toBe("state");
    expect(groupingIn("{", "bds")).toBe("state");
  });
});

describe("savedGrouping and rememberGrouping", () => {
  it("holds a choice and reads it back", () => {
    const { store, raw } = shelf();
    vi.stubGlobal("localStorage", store);
    expect(savedGrouping("bds")).toBe("state");
    rememberGrouping("bds", "project");
    expect(savedGrouping("bds")).toBe("project");
    expect(raw()).toBe(`{"bds":"project"}`);
  });

  it("holds every venture's choice under the one key, and leaves the others where they were", () => {
    const { store } = shelf();
    vi.stubGlobal("localStorage", store);
    rememberGrouping("bds", "project");
    rememberGrouping("nd", "state");
    rememberGrouping("bds", "project");
    expect(savedGrouping("bds")).toBe("project");
    expect(savedGrouping("nd")).toBe("state");
  });

  it("writes over a value that says nothing rather than failing on it", () => {
    const { store, raw } = shelf({ [KEY]: "not json at all" });
    vi.stubGlobal("localStorage", store);
    expect(savedGrouping("bds")).toBe("state");
    rememberGrouping("bds", "project");
    expect(raw()).toBe(`{"bds":"project"}`);
  });

  it("answers state, and says nothing, when there is no storage to read at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(savedGrouping("bds")).toBe("state");
    expect(() => rememberGrouping("bds", "project")).not.toThrow();
  });

  it("answers state, and says nothing, when storage refuses", () => {
    vi.stubGlobal("localStorage", refuses);
    expect(savedGrouping("bds")).toBe("state");
    expect(() => rememberGrouping("bds", "project")).not.toThrow();
  });
});
