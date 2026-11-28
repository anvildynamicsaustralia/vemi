import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STEP_NAMES } from "../../shared/setup/buildSteps.js";
import { GetScreen, type GetActions } from "./GetFlow.js";
import { canMove, initial, reduce, type Action, type GetState } from "./getFlowState.js";
import { KEY_WORDS } from "./MoveKey.js";
import { MOVE_DONE_WORDS } from "./MoveDone.js";
import { MOVE_WORDS } from "./MoveBuild.js";

const KEY = "fake-key-0123456789";
const ADDRESS = "https://mine.sub.workers.dev";
const OPEN = `${ADDRESS}/auth/move-in?t=hand`;
const none = (): void => undefined;
const on: GetActions = {
  signUpOpened: none, typeKey: none, pasteKey: none, typeName: none, next: none, back: none, retry: none, keepUpdated: none, finish: none,
  typeEmail: none, typePassword: none, pickFile: none, proveKey: none, keyPageOpened: none, copyAddress: none,
};
const run = (state: GetState, ...actions: Action[]): GetState => actions.reduce(reduce, state);
const draw = (state: GetState): string => renderToStaticMarkup(<GetScreen state={state} on={on} />);
const EM_DASH = String.fromCharCode(0x2014);

const built = (hasSource: boolean): GetState =>
  run(
    initial(null, hasSource),
    { type: "keyTyped", key: KEY },
    { type: "keyChecked", key: KEY, check: { kind: "ok", accountId: "a", accountName: "Sam" } },
    ...STEP_NAMES.map((step): Action => ({ type: "buildStep", step, state: "done" })),
    { type: "buildDone", address: ADDRESS },
  );
const atMove = (): GetState => run(built(true), { type: "go", step: "move" });
const login = (state: GetState): GetState => run(state, { type: "emailTyped", email: "sam@example.com" }, { type: "passwordTyped", password: "a-long-new-password" });
const moved = (): GetState =>
  run(login(atMove()), { type: "moveDone", counts: { venture: 2, project: 3, task: 1 }, recoveryCode: "rec-0000", openLink: OPEN, levelNames: { space: "Realm" } });

const screens = (): Record<string, string> => ({
  name: draw(run(built(true), { type: "go", step: "name" }, { type: "nameChecked", name: "vemi", check: { kind: "ok", address: ADDRESS } })),
  built: draw(run(built(true), { type: "go", step: "build" })),
  working: draw(run(login(atMove()), { type: "moveStarted" })),
  failed: draw(run(login(atMove()), { type: "moveStarted" }, { type: "moveFailed", reason: "Your new copy is still starting. Try again in a minute." })),
  final: draw(run(login(atMove()), { type: "moveStarted" }, { type: "moveFailed", reason: "Your copy was made. Sign in to it and move from Account > Your data.", final: true })),
  missing: draw(run(initial({ step: "move", name: "mine", address: ADDRESS }), { type: "keyTyped", key: KEY }, { type: "go", step: "move" })),
  moved: draw(run(moved(), { type: "go", step: "move" })),
  done: draw(run(moved(), { type: "finished", kept: true })),
});

describe("the helper's sixth row", () => {
  it("shows Copying your stuff after the build's six, and not without a source", () => {
    expect(screens()["built"]).toContain("Copying your stuff");
    expect(screens()["built"]?.indexOf("Giving it an address")).toBeLessThan(screens()["built"]?.indexOf("Copying your stuff") ?? 0);
    expect(draw(run(built(false), { type: "go", step: "build" }))).not.toContain("Copying your stuff");
  });

  it("works on the move's step and keeps the build's dot", () => {
    expect(screens()["working"]).toMatch(/class="get-row run"[^>]*>(?:(?!<\/li>).)*Copying your stuff/s);
    expect(screens()["working"]).toContain('aria-label="Step 4 of 5: Build"');
  });

  it("asks for the email and password on the name step, with the copy's own password line", () => {
    const html = screens()["name"] ?? "";
    expect(html).toContain(`>${MOVE_WORDS.email}<`);
    expect(html).toContain('type="password"');
    expect(html).toContain(MOVE_WORDS.line);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Build my VEMI/);
  });

  it("asks for the file and the login again on a reopened tab, with nothing held", () => {
    const html = screens()["missing"] ?? "";
    expect(html).toContain('type="file"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("a-long-new-password");
  });

  it("shows the problem with Try again, and keeps the build's rows done", () => {
    const html = screens()["failed"] ?? "";
    expect(html).toContain("Something stopped at copying your stuff");
    expect(html).toContain("Your new copy is still starting.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Use the Deploy button instead");
    expect(html.match(/class="get-row ok"/g)).toHaveLength(6);
  });

  it("offers a way into the copy, and no Try again, once the copy was made", () => {
    const html = screens()["final"] ?? "";
    expect(html).toContain("Your copy was made.");
    expect(html).toContain(`href="${ADDRESS}"`);
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("still starting");
  });

  it("never draws the password, whatever the screen", () => {
    for (const [name, html] of Object.entries(screens())) expect(html, name).not.toContain("a-long-new-password");
  });
});

describe("the done screen after a move", () => {
  it("shows the real counts in the person's names, the address and the hand-over link", () => {
    const html = screens()["done"] ?? "";
    expect(html).toContain("2 Realms");
    expect(html).toContain("3 Projects");
    expect(html).toContain("1 Task");
    expect(html).toContain("mine.sub.workers.dev");
    expect(html).toContain(MOVE_DONE_WORDS.open);
    expect(html).toContain(`href="${OPEN.replaceAll("&", "&amp;")}"`);
    expect(html).toContain(MOVE_DONE_WORDS.home);
    expect(html).toContain(MOVE_DONE_WORDS.reminders);
    expect(html).toContain("rec-0000");
  });

  it("carries no em-dash, help or undo", () => {
    for (const [name, html] of Object.entries(screens())) {
      expect(html.replace(/<[^>]*>/g, " ").includes(EM_DASH), name).toBe(false);
      expect(html, name).not.toMatch(/help|undo|redo/i);
    }
  });
});

describe("the helper opened from an old account", () => {
  const old = (): GetState =>
    run(initial(null, false, true), { type: "keyTyped", key: KEY },
      { type: "keyChecked", key: KEY, check: { kind: "ok", accountId: "a", accountName: "Sam" } },
      ...STEP_NAMES.map((step): Action => ({ type: "buildStep", step, state: "done" })),
      { type: "buildDone", address: ADDRESS }, { type: "go", step: "move" });

  it("asks for the file on the move step", () => {
    expect(draw(old())).toContain(MOVE_WORDS.file);
  });

  it("says on the done screen that the old account is untouched and can be deleted from Account", () => {
    const done = draw(run(login(old()), { type: "moveDone", counts: { task: 1 }, recoveryCode: "rec-0000", openLink: OPEN, levelNames: {} }, { type: "finished", kept: true }));
    expect(done).toContain(MOVE_DONE_WORDS.old);
    expect(MOVE_DONE_WORDS.old).toContain("untouched");
    expect(MOVE_DONE_WORDS.old).toContain("Account");
    expect(done).not.toContain(EM_DASH);
  });

  it("says nothing of an old account when the move did not come from one", () => {
    expect(screens()["done"]).not.toContain(MOVE_DONE_WORDS.old);
  });
});

describe("a file with locked content", () => {
  const keys = { keyRef: "r", keyCheck: "c", wraps: [{ id: "k", kind: "recovery", label: "Recovery", deviceId: null, credentialId: null, salt: null, iterations: null, wrapped: "x", createdAt: "t" }] } as const;

  it("asks for one of the file's own ways in before it sends, and goes on once one opens", () => {
    const asked = run(login(atMove()), { type: "moveNeedsKey", keys });
    expect(canMove(asked)).toBe(false);
    const html = draw(asked);
    expect(html).toContain(KEY_WORDS.title);
    expect(html).toContain(KEY_WORDS.recovery);
    expect(draw(run(asked, { type: "keyFailed", reason: "That recovery key did not open it." }))).toContain("That recovery key did not open it.");
    const proved = run(asked, { type: "keyProved" });
    expect(proved.move.kind).toBe("idle");
    expect(canMove(proved)).toBe(true);
    expect(draw(proved)).not.toContain(KEY_WORDS.title);
  });

  it("keeps the ids and the locked count the answer gave", () => {
    const done = run(login(atMove()), { type: "moveDone", counts: { note: 1 }, recoveryCode: "rec", openLink: OPEN, levelNames: {}, ids: { a: "b" }, locked: 2 });
    expect(done.move).toMatchObject({ kind: "ok", ids: { a: "b" }, locked: 2 });
    expect(draw(done)).not.toContain(EM_DASH);
  });
});
