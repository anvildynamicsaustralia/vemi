import { describe, expect, it } from "vitest";
import { STEP_NAMES } from "../../shared/setup/buildSteps.js";
import { saveText, type Saved } from "../../shared/setup/getFlow.js";
import { canGoNext, canMove, initial, reduce, toSaved, type Action, type GetState } from "./getFlowState.js";

const KEY = "fake-key-0123456789";
const ADDRESS = "https://mine.sub.workers.dev";

const run = (state: GetState, ...actions: Action[]): GetState => actions.reduce(reduce, state);
const withKey = (state: GetState): GetState =>
  run(state, { type: "keyTyped", key: KEY }, { type: "keyChecked", key: KEY, check: { kind: "ok", accountId: "acct-test", accountName: "Sam" } });

describe("the first screen", () => {
  it("opens at the account step with the default name and the switch on", () => {
    const state = initial(null);
    expect(state.step).toBe("account");
    expect(state.name).toBe("vemi");
    expect(state.keepUpdated).toBe(true);
    expect(state.key).toBe("");
    expect(state.address).toBeNull();
  });

  it("opens a closed tab at the key step when the key is gone, and goes back to the saved step after it", () => {
    const saved: Saved = { step: "build", name: "mine", address: null };
    const state = initial(saved);
    expect(state.step).toBe("permission");
    expect(state.name).toBe("mine");
    expect(state.resumeTo).toBe("build");
    const after = run(withKey(state), { type: "next" });
    expect(after.step).toBe("build");
    expect(after.resumeTo).toBeNull();
  });

  it("opens a finished setup on Done with its address", () => {
    const state = initial({ step: "done", name: "mine", address: ADDRESS });
    expect(state.step).toBe("done");
    expect(state.address).toBe(ADDRESS);
  });
});

describe("the key step", () => {
  it("cannot go on until the key is checked, and goes on once it is", () => {
    let state = run(initial(null), { type: "next" });
    expect(state.step).toBe("permission");
    expect(canGoNext(state)).toBe(false);
    expect(run(state, { type: "next" }).step).toBe("permission");
    state = run(state, { type: "keyTyped", key: `  ${KEY} ` });
    expect(state.key).toBe(KEY);
    expect(state.keyCheck.kind).toBe("checking");
    expect(canGoNext(state)).toBe(false);
    state = run(state, { type: "keyChecked", key: KEY, check: { kind: "ok", accountId: "acct-test", accountName: "Sam" } });
    expect(canGoNext(state)).toBe(true);
    expect(run(state, { type: "next" }).step).toBe("name");
  });

  it("shows a problem and holds the step when the key is refused", () => {
    const state = run(initial(null), { type: "next" }, { type: "keyTyped", key: KEY }, { type: "keyChecked", key: KEY, check: { kind: "bad", reason: "The key was refused." } });
    expect(state.keyCheck).toEqual({ kind: "bad", reason: "The key was refused." });
    expect(canGoNext(state)).toBe(false);
  });

  it("ignores an answer for a key that is no longer in the box", () => {
    const state = run(initial(null), { type: "keyTyped", key: KEY }, { type: "keyTyped", key: `${KEY}2` }, { type: "keyChecked", key: KEY, check: { kind: "ok", accountId: "a", accountName: "Old" } });
    expect(state.keyCheck.kind).toBe("checking");
  });

  it("forgets a proof when the key is cleared", () => {
    expect(run(withKey(initial(null)), { type: "keyTyped", key: "" }).keyCheck.kind).toBe("idle");
  });
});

describe("the name step", () => {
  const atName = (): GetState => run(withKey(initial(null)), { type: "go", step: "name" });

  it("goes on only with a checked name", () => {
    let state = atName();
    expect(canGoNext(state)).toBe(false);
    state = run(state, { type: "nameChecked", name: "vemi", check: { kind: "ok", address: ADDRESS } });
    expect(canGoNext(state)).toBe(true);
    expect(run(state, { type: "next" }).step).toBe("build");
  });

  it("answers a clash with a sentence and holds the step", () => {
    const state = run(atName(), { type: "nameChecked", name: "vemi", check: { kind: "bad", reason: "This account already has an app called vemi that VEMI did not make." } });
    expect(state.nameCheck.kind).toBe("bad");
    expect(canGoNext(state)).toBe(false);
  });

  it("marks an empty name bad at once and a typed one as being checked", () => {
    expect(run(atName(), { type: "nameTyped", name: "!!" }).nameCheck.kind).toBe("bad");
    expect(run(atName(), { type: "nameTyped", name: "Sam" }).nameCheck.kind).toBe("checking");
  });

  it("ignores an answer for a name that has been typed over", () => {
    const state = run(atName(), { type: "nameTyped", name: "sam" }, { type: "nameChecked", name: "other", check: { kind: "ok", address: ADDRESS } });
    expect(state.nameCheck.kind).toBe("checking");
  });
});

describe("the build step", () => {
  const building = (): GetState => run(withKey(initial(null)), { type: "go", step: "build" }, { type: "buildStarted" });

  it("ticks each step as it is done and goes on only when all six are", () => {
    let state = building();
    for (const step of STEP_NAMES.slice(0, 5)) state = run(state, { type: "buildStep", step, state: "start" }, { type: "buildStep", step, state: "done" });
    expect(canGoNext(state)).toBe(false);
    state = run(state, { type: "buildStep", step: "Address", state: "done" }, { type: "buildDone", address: ADDRESS });
    expect(canGoNext(state)).toBe(true);
    expect(state.address).toBe(ADDRESS);
    expect(run(state, { type: "next" }).step).toBe("update");
  });

  it("survives a failure at any step: the others stay done, the failed one is named, a rerun clears it", () => {
    for (const [at, failing] of STEP_NAMES.entries()) {
      let state = building();
      for (const step of STEP_NAMES.slice(0, at)) state = run(state, { type: "buildStep", step, state: "done" });
      state = run(state, { type: "buildStep", step: failing, state: "start" }, { type: "buildStep", step: failing, state: "failed" }, { type: "buildFailed", step: failing, reason: "Cloudflare said no." });
      expect(state.build.failed).toBe(failing);
      expect(state.build.reason).toBe("Cloudflare said no.");
      expect(state.build.done).toEqual(STEP_NAMES.slice(0, at));
      expect(canGoNext(state)).toBe(false);
      state = run(state, { type: "buildStarted" }, { type: "buildStep", step: failing, state: "start" });
      expect(state.build.failed).toBeNull();
      expect(state.build.reason).toBeNull();
      expect(state.build.running).toBe(failing);
    }
  });

  it("holds a failure that came before any step, such as files that would not load", () => {
    const state = run(building(), { type: "buildFailed", step: null, reason: "The VEMI files could not be fetched." });
    expect(state.build.failed).toBeNull();
    expect(state.build.reason).toBe("The VEMI files could not be fetched.");
  });

  it("counts a skipped step as done, so a rerun starts where it stopped", () => {
    const state = run(building(), { type: "buildStep", step: "Database", state: "skipped" });
    expect(state.build.done).toEqual(["Database"]);
  });
});

describe("the last step", () => {
  const atUpdate = (): GetState => run(withKey(initial(null)), { type: "go", step: "update" });

  it("has the switch on by default and turns it off", () => {
    expect(atUpdate().keepUpdated).toBe(true);
    expect(run(atUpdate(), { type: "keepUpdated", on: false }).keepUpdated).toBe(false);
  });

  it("holds the step with a sentence when the hand-over fails, and finishes on success", () => {
    const failed = run(atUpdate(), { type: "finishing" }, { type: "finishFailed", reason: "The new copy is not answering yet." });
    expect(failed.step).toBe("update");
    expect(failed.finish.kind).toBe("bad");
    const done = run(failed, { type: "finishing" }, { type: "finished", kept: false });
    expect(done.step).toBe("done");
    expect(done.kept).toBe(false);
  });

  it("lets go of the key once the hand-over is made", () => {
    const done = run(atUpdate(), { type: "finished", kept: true });
    expect(done.key).toBe("");
    expect(done.keyCheck.kind).toBe("idle");
  });
});

describe("what is kept for a closed tab", () => {
  it("is the step, the name and the address, with no key, however far the page has got", () => {
    const state = run(withKey(initial(null)), { type: "go", step: "update" }, { type: "buildDone", address: ADDRESS }, { type: "nameTyped", name: "mine" });
    const saved = toSaved(state);
    expect(saved).toEqual({ step: "update", name: "mine", address: ADDRESS });
    const text = saveText(saved, 1);
    expect(text).not.toContain(KEY);
    expect(state.key).toBe(KEY);
  });

  it("falls back to the default name when the box holds nothing usable", () => {
    expect(toSaved(run(initial(null), { type: "nameTyped", name: "!!" })).name).toBe("vemi");
  });
});

describe("the move", () => {
  const EMAIL = "sam@example.com";
  const PASSWORD = "a-long-new-password";
  const built = (state: GetState): GetState =>
    run(state, ...STEP_NAMES.map((step): Action => ({ type: "buildStep", step, state: "done" })), { type: "buildDone", address: ADDRESS });
  const moving = (): GetState => run(built(withKey(initial(null, true))), { type: "go", step: "build" });

  it("has no move step and no login fields without a source", () => {
    const state = run(built(withKey(initial(null))), { type: "go", step: "build" }, { type: "next" });
    expect(state.withMove).toBe(false);
    expect(state.step).toBe("update");
  });

  it("goes from the build to the move and from the move to the update, with the source", () => {
    const state = moving();
    expect(state.withMove).toBe(true);
    const atMove = run(state, { type: "next" });
    expect(atMove.step).toBe("move");
    expect(canGoNext(atMove)).toBe(false);
    const done = run(atMove, { type: "moveDone", counts: { task: 2 }, recoveryCode: "rec", openLink: `${ADDRESS}/in`, levelNames: {} });
    expect(canGoNext(done)).toBe(true);
    expect(run(done, { type: "next" }).step).toBe("update");
  });

  it("holds the name step until the email and password are fit, when there is a source", () => {
    const name = run(withKey(initial(null, true)), { type: "go", step: "name" }, { type: "nameChecked", name: "vemi", check: { kind: "ok", address: ADDRESS } });
    expect(canGoNext(name)).toBe(false);
    expect(canGoNext(run(name, { type: "emailTyped", email: EMAIL }))).toBe(false);
    expect(canGoNext(run(name, { type: "emailTyped", email: EMAIL }, { type: "passwordTyped", password: PASSWORD }))).toBe(true);
  });

  it("starts the move only with the file, a login and nothing running", () => {
    const at = run(moving(), { type: "next" });
    expect(canMove(at)).toBe(false);
    const ready = run(at, { type: "emailTyped", email: EMAIL }, { type: "passwordTyped", password: PASSWORD });
    expect(canMove(ready)).toBe(true);
    expect(canMove(run(ready, { type: "moveStarted" }))).toBe(false);
    expect(canMove(run(ready, { type: "moveFailed", reason: "x" }))).toBe(false);
    expect(canMove(run(ready, { type: "moveFailed", reason: "x" }, { type: "moveReset" }))).toBe(true);
    const noFile = run(initial({ step: "move", name: "mine", address: ADDRESS }), { type: "keyTyped", key: KEY }, { type: "go", step: "move" });
    const login = run(noFile, { type: "emailTyped", email: EMAIL }, { type: "passwordTyped", password: PASSWORD });
    expect(canMove(login)).toBe(false);
    expect(canMove(run(login, { type: "sourceChosen" }))).toBe(true);
  });

  it("resumes a closed tab at the move, with the build whole, and asks for the key first", () => {
    const state = initial({ step: "move", name: "mine", address: ADDRESS });
    expect(state.step).toBe("permission");
    expect(state.resumeTo).toBe("move");
    expect(state.withMove).toBe(true);
    expect(state.hasSource).toBe(false);
    expect(state.build.done).toEqual(STEP_NAMES);
    const after = run(withKey(state), { type: "next" });
    expect(after.step).toBe("move");
    expect(after.address).toBe(ADDRESS);
  });

  it("keeps the email, password and results out of what a closed tab keeps, and lets go of the login at the end", () => {
    const state = run(moving(), { type: "emailTyped", email: EMAIL }, { type: "passwordTyped", password: PASSWORD }, { type: "next" });
    expect(Object.keys(toSaved(state)).sort()).toEqual(["address", "name", "step"]);
    expect(saveText(toSaved(state), 1)).not.toContain(PASSWORD);
    expect(saveText(toSaved(state), 1)).not.toContain(EMAIL);
    const done = run(state, { type: "moveDone", counts: {}, recoveryCode: "rec", openLink: "l", levelNames: {} });
    expect(done.password).toBe("");
    expect(done.email).toBe("");
  });
});

describe("a page opened from an old account", () => {
  it("moves with no file in hand, and remembers where the data came from", () => {
    const state = initial(null, false, true);
    expect(state.withMove).toBe(true);
    expect(state.hasSource).toBe(false);
    expect(state.fromOld).toBe(true);
  });

  it("is not set on a plain open", () => {
    expect(initial(null).fromOld).toBe(false);
    expect(initial(null).withMove).toBe(false);
  });
});
