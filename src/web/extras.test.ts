import { describe, expect, it } from "vitest";
import { EXTRA_SWITCHES, type ExtraSwitches } from "@vemi/shared";
import {
  EXTRA_KEYS, SINGLE_KEYS_KEY, SMART_DATES_KEY, currentExtras, extraOn, keepExtras, onExtras, readExtras, readSmartDates, setExtras,
  singleKeysOn, smartDatesOn,
} from "./extras.js";

const ALL_ON: ExtraSwitches = { smartDates: true, singleKeys: true, recent: true, rings: true, comingUp: true, burst: true };

const store = (value: string | null): Pick<Storage, "getItem"> => ({ getItem: () => value });
const NOW = new Date("2026-11-17T01:00:00Z");

describe("the smart dates switch", () => {
  it("is on when nothing is kept", () => expect(smartDatesOn(store(null))).toBe(true));
  it("is off only for the word off", () => {
    expect(smartDatesOn(store("off"))).toBe(false);
    expect(smartDatesOn(store("on"))).toBe(true);
    expect(smartDatesOn(store("nonsense"))).toBe(true);
  });
  it("is on when the browser will not say", () => {
    expect(smartDatesOn({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
  });
  it("keeps one versioned key", () => expect(SMART_DATES_KEY).toBe("vemi:smartDates:v1"));

  it("reads dates out of a title when on", () => {
    const got = readSmartDates("call vet tomorrow", NOW, "Australia/Sydney", store(null));
    expect(got.title).toBe("call vet");
    expect(got.when).toBe("2026-11-18");
  });
  it("returns the text unchanged when off", () => {
    const got = readSmartDates("call vet tomorrow", NOW, "Australia/Sydney", store("off"));
    expect(got).toEqual({ title: "call vet tomorrow", when: null, repeat: null, remindAt: null, tokens: [] });
  });
});

describe("the single keys switch", () => {
  it("keeps one versioned key", () => expect(SINGLE_KEYS_KEY).toBe("vemi:singleKeys:v1"));
  it("is on when nothing is kept, and off only for the word off", () => {
    expect(singleKeysOn(store(null))).toBe(true);
    expect(singleKeysOn(store("off"))).toBe(false);
    expect(singleKeysOn(store("on"))).toBe(true);
    expect(singleKeysOn(store("nonsense"))).toBe(true);
  });
  it("is on when the browser will not say", () => {
    expect(singleKeysOn({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
  });
});

describe("every Extras switch", () => {
  const sink = (): { kept: Record<string, string>; store: Pick<Storage, "setItem" | "removeItem"> } => {
    const kept: Record<string, string> = {};
    return {
      kept,
      store: { setItem: (k, v) => { kept[k] = v; }, removeItem: (k) => { delete kept[k]; } },
    };
  };

  it("names six switches, each with its own versioned key", () => {
    expect(Object.keys(EXTRA_KEYS).sort()).toEqual([...EXTRA_SWITCHES].sort());
    expect(new Set(Object.values(EXTRA_KEYS)).size).toBe(6);
    expect(EXTRA_KEYS.smartDates).toBe(SMART_DATES_KEY);
    expect(EXTRA_KEYS.singleKeys).toBe(SINGLE_KEYS_KEY);
  });

  it("is on unless the key says off, for each switch", () => {
    for (const name of EXTRA_SWITCHES) {
      expect(extraOn(name, store(null))).toBe(true);
      expect(extraOn(name, store("off"))).toBe(false);
    }
  });

  it("reads the account's answer: on unless it says false", () => {
    expect(readExtras({ recent: false, rings: true })).toEqual({ ...ALL_ON, recent: false });
    expect(readExtras(null)).toEqual(ALL_ON);
    expect(readExtras({ burst: "no" })).toEqual(ALL_ON);
  });

  it("writes the device keys: off is kept, on removes the key", () => {
    const { kept, store: s } = sink();
    keepExtras({ ...ALL_ON, rings: false, burst: false }, s);
    expect(kept).toEqual({ [EXTRA_KEYS.rings]: "off", [EXTRA_KEYS.burst]: "off" });
    keepExtras(ALL_ON, s);
    expect(kept).toEqual({});
  });

  it("keeps going when the browser will not keep it", () => {
    expect(() => keepExtras(ALL_ON, { setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } })).not.toThrow();
    expect(() => keepExtras(ALL_ON, null)).not.toThrow();
  });

  it("a switch change reaches readers at once", () => {
    const heard: ExtraSwitches[] = [];
    const stop = onExtras((e) => heard.push(e));
    setExtras({ ...ALL_ON, comingUp: false }, null);
    expect(currentExtras().comingUp).toBe(false);
    expect(heard.at(-1)?.comingUp).toBe(false);
    setExtras(ALL_ON, null);
    stop();
  });
});
