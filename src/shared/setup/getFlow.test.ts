import { describe, expect, it } from "vitest";
import { STEP_NAMES } from "./buildSteps.js";
import {
  BUILD_WORDS, DEFAULT_NAME, FLOW_STEPS, SAVED_FOR_MS, afterKey, buildFinished, buildPercent, buildRows, claimAddress, claimFor,
  NUMBERED_STEPS, dotStep, emailProblem, fromLocalMode, fromOldAccount, moveAddress, passwordProblem,
  keyFrom, keyProblem, nameFrom, nameProblem, needsKey, restore, resumeAt, saveText, stepAfter, stepBefore, type Saved,
} from "./getFlow.js";

const NOW = 1_800_000_000_000;
const KEY = "fake-key-0123456789";
const ACCOUNT = "acct-test-0123456789";
const saved = (over: Partial<Saved> = {}): Saved => ({ step: "name", name: "mine", address: null, ...over });

describe("the steps", () => {
  it("run in the order of the flow, and stop at the ends", () => {
    expect(FLOW_STEPS).toEqual(["account", "permission", "name", "build", "move", "update", "done"]);
    expect(stepAfter("account")).toBe("permission");
    expect(stepAfter("done")).toBe("done");
    expect(stepBefore("name")).toBe("permission");
    expect(stepBefore("account")).toBe("account");
  });

  it("needs the key from the name step on, and not before", () => {
    expect(FLOW_STEPS.filter(needsKey)).toEqual(["name", "build", "move", "update"]);
  });
});

describe("the move's step", () => {
  it("is passed over when there is nothing to move, and sits between the build and the update when there is", () => {
    expect(stepAfter("build")).toBe("update");
    expect(stepAfter("build", true)).toBe("move");
    expect(stepAfter("move", true)).toBe("update");
    expect(stepBefore("update")).toBe("build");
    expect(stepBefore("update", true)).toBe("move");
    expect(stepBefore("move", true)).toBe("build");
  });

  it("is kept for a closed tab only with an address, and nothing else is added to what is kept", () => {
    const text = saveText({ step: "move", name: "mine", address: "https://mine.sub.workers.dev" }, NOW);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["address", "at", "name", "step", "v"]);
    expect(restore(text, NOW + 1000)?.step).toBe("move");
    expect(restore(saveText({ step: "move", name: "mine", address: null }, NOW), NOW + 1000)).toBeNull();
  });

  it("shares the build's dot", () => {
    expect(dotStep("move")).toBe("build");
    expect(NUMBERED_STEPS).toHaveLength(5);
  });

  it("holds the email and password to the copy's own rules and sends to the copy's own door", () => {
    expect(emailProblem("sam@example.com")).toBeNull();
    expect(emailProblem("sam")).not.toBeNull();
    expect(passwordProblem("short")).not.toBeNull();
    expect(passwordProblem("long enough pw")).toBeNull();
    expect(moveAddress("https://mine.sub.workers.dev/")).toBe("https://mine.sub.workers.dev/setup/move");
  });
});

describe("a reopened tab", () => {
  it("keeps the step, the name and the address, and nothing else", () => {
    const text = saveText(saved({ step: "build" }), NOW);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["address", "at", "name", "step", "v"]);
    expect(restore(text, NOW + 1000)).toEqual({ step: "build", name: "mine", address: null });
  });

  it("holds neither a key nor a claim code, whatever the name is", async () => {
    const code = await claimFor(ACCOUNT, "mine");
    const text = saveText(saved({ step: "update", address: "https://mine.sub.workers.dev" }), NOW);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(code);
  });

  it("is forgotten after an hour, and not before", () => {
    const text = saveText(saved(), NOW);
    expect(restore(text, NOW + SAVED_FOR_MS - 1)).not.toBeNull();
    expect(restore(text, NOW + SAVED_FOR_MS)).toBeNull();
    expect(restore(text, NOW - 1)).toBeNull();
  });

  it("is refused when it is not ours", () => {
    expect(restore(null, NOW)).toBeNull();
    expect(restore("not json", NOW)).toBeNull();
    expect(restore("[]", NOW)).toBeNull();
    expect(restore(JSON.stringify({ v: 2, step: "name", name: "a", address: null, at: NOW }), NOW)).toBeNull();
    expect(restore(JSON.stringify({ v: 1, step: "elsewhere", name: "a", address: null, at: NOW }), NOW)).toBeNull();
    expect(restore(JSON.stringify({ v: 1, step: "name", name: "a", address: "http://x.test", at: NOW }), NOW)).toBeNull();
    expect(restore(JSON.stringify({ v: 1, step: "name", name: "a".repeat(80), address: null, at: NOW }), NOW)).toBeNull();
  });

  it("does not show Done or the hand-over without an address to open", () => {
    expect(restore(saveText(saved({ step: "done" }), NOW), NOW)).toBeNull();
    expect(restore(saveText(saved({ step: "update" }), NOW), NOW)).toBeNull();
    expect(restore(saveText(saved({ step: "done", address: "https://mine.sub.workers.dev" }), NOW), NOW)?.step).toBe("done");
  });

  it("resumes at the saved step, or at the key when the key is gone", () => {
    expect(resumeAt(null, false)).toBe("account");
    expect(resumeAt(saved({ step: "account" }), false)).toBe("account");
    expect(resumeAt(saved({ step: "permission" }), false)).toBe("permission");
    for (const step of ["name", "build", "update"] as const) {
      expect(resumeAt(saved({ step, address: "https://a.b.workers.dev" }), false)).toBe("permission");
      expect(resumeAt(saved({ step, address: "https://a.b.workers.dev" }), true)).toBe(step);
    }
    expect(resumeAt(saved({ step: "done", address: "https://a.b.workers.dev" }), false)).toBe("done");
  });

  it("goes back to where the tab was once the key is in, else on to the name", () => {
    expect(afterKey(saved({ step: "build" }))).toBe("build");
    expect(afterKey(saved({ step: "permission" }))).toBe("name");
    expect(afterKey(null)).toBe("name");
  });
});

describe("the key", () => {
  it("says nothing about an empty box, and one sentence about a key that cannot be whole", () => {
    expect(keyProblem("")).toBeNull();
    expect(keyProblem("   ")).toBeNull();
    expect(keyProblem("short")).toMatch(/whole key/);
    expect(keyProblem("has a space inside it")).toMatch(/whole key/);
    expect(keyProblem("a,b-0123456789")).toMatch(/whole key/);
    expect(keyProblem("x".repeat(513))).toMatch(/whole key/);
    expect(keyProblem(KEY)).toBeNull();
  });

  it("trims what was pasted, and takes nothing that is not fit to send", () => {
    expect(keyFrom(`  ${KEY}\n`)).toBe(KEY);
    expect(keyFrom("short")).toBeNull();
    expect(keyFrom("")).toBeNull();
  });
});

describe("the name", () => {
  it("is made into lowercase letters, numbers and single dashes", () => {
    expect(nameFrom("Sam's VEMI")).toBe("sam-s-vemi");
    expect(nameFrom("  --Mine--  ")).toBe("mine");
    expect(nameFrom("a".repeat(60))).toHaveLength(40);
    expect(nameFrom("!!!")).toBe("");
  });

  it("has a sentence when it cannot be used, and none when it can", () => {
    expect(nameProblem("")).toMatch(/Pick a name/);
    expect(nameProblem("???")).toMatch(/Pick a name/);
    expect(nameProblem(DEFAULT_NAME)).toBeNull();
    expect(nameProblem("Sam")).toBeNull();
  });
});

describe("the build's list", () => {
  it("has a plain-words row for each of the six steps, in order", () => {
    const rows = buildRows({ done: [], running: null, failed: null });
    expect(rows.map((r) => r.step)).toEqual([...STEP_NAMES]);
    expect(rows.map((r) => r.state)).toEqual(Array(6).fill("wait"));
    for (const step of STEP_NAMES) {
      expect(BUILD_WORDS[step].label.length).toBeGreaterThan(5);
      expect(`${BUILD_WORDS[step].label}${BUILD_WORDS[step].note}`).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("ticks what is done, marks the running step and the failed one", () => {
    const rows = buildRows({ done: ["Database", "Data layout"], running: "App files", failed: null });
    expect(rows.map((r) => r.state)).toEqual(["ok", "ok", "run", "wait", "wait", "wait"]);
    const bad = buildRows({ done: ["Database"], running: null, failed: "Data layout" });
    expect(bad.map((r) => r.state)).toEqual(["ok", "bad", "wait", "wait", "wait", "wait"]);
  });

  it("counts the share done and knows when all six are", () => {
    expect(buildPercent({ done: [], running: null, failed: null })).toBe(0);
    expect(buildPercent({ done: ["Database", "Data layout", "App files"], running: null, failed: null })).toBe(50);
    expect(buildFinished({ done: [...STEP_NAMES], running: null, failed: null })).toBe(true);
    expect(buildFinished({ done: ["Database"], running: null, failed: null })).toBe(false);
  });
});

describe("the claim code", () => {
  it("is the same for the same key and name, so a reopened tab can still hand over", async () => {
    expect(await claimFor(ACCOUNT, "mine")).toBe(await claimFor(ACCOUNT, "mine"));
  });

  it("does not follow the key: a build resumed with another key still hands over", async () => {
    // The function takes the account and the name and no key, so the code a resumed page sends
    // is the one the copy was built with, whatever key it was resumed with.
    expect(claimFor.length).toBe(2);
    const code = await claimFor(ACCOUNT, "mine");
    expect(code).toBe(await claimFor(ACCOUNT, "mine"));
    // One account and name give one code, and another account or name gives another.
    expect(code).not.toBe(await claimFor(ACCOUNT, "theirs"));
    expect(code).not.toBe(await claimFor(ACCOUNT + "x", "mine"));
  });

  it("differs by account and by name, is 32 URL-safe characters, and shows nothing of the key", async () => {
    const code = await claimFor(ACCOUNT, "mine");
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(code).not.toBe(await claimFor(`${ACCOUNT}x`, "mine"));
    expect(code).not.toBe(await claimFor(ACCOUNT, "other"));
    expect(code).not.toContain(KEY);
  });
});

describe("the hand-over address", () => {
  it("is the copy's own /setup/claim", () => {
    expect(claimAddress("https://mine.sub.workers.dev")).toBe("https://mine.sub.workers.dev/setup/claim");
    expect(claimAddress("https://mine.sub.workers.dev/")).toBe("https://mine.sub.workers.dev/setup/claim");
  });
});

describe("fromOldAccount", () => {
  it("is true only for the one query an old account's card opens", () => {
    expect(fromOldAccount("?from=old")).toBe(true);
    expect(fromOldAccount("")).toBe(false);
    expect(fromOldAccount("?from=other")).toBe(false);
    expect(fromOldAccount("?x=1&from=old")).toBe(true);
  });
});

describe("fromLocalMode", () => {
  it("is true only for the one query local mode's card opens, and not for an old account's", () => {
    expect(fromLocalMode("?from=local")).toBe(true);
    expect(fromLocalMode("")).toBe(false);
    expect(fromLocalMode("?from=old")).toBe(false);
    expect(fromOldAccount("?from=local")).toBe(false);
  });
});
