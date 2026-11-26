import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STEP_NAMES } from "../../shared/setup/buildSteps.js";
import { DEPLOY_LINK, KEY_LIST_LINK, SIGN_UP_LINK, type FlowStep } from "../../shared/setup/getFlow.js";
import { tokenLink } from "../../shared/setup/tokenLink.js";
import { GetScreen, WORDS, type GetActions } from "./GetFlow.js";
import { initial, reduce, type Action, type GetState } from "./getFlowState.js";

const KEY = "fake-key-0123456789";
const ADDRESS = "https://mine.sub.workers.dev";
const none = (): void => undefined;
const on: GetActions = {
  signUpOpened: none, typeKey: none, pasteKey: none, typeName: none, next: none, back: none, retry: none, keepUpdated: none, finish: none,
  typeEmail: none, typePassword: none, pickFile: none, proveKey: none,
};

const run = (state: GetState, ...actions: Action[]): GetState => actions.reduce(reduce, state);
const keyed = (): GetState =>
  run(initial(null), { type: "keyTyped", key: KEY }, { type: "keyChecked", key: KEY, check: { kind: "ok", accountId: "acct-test", accountName: "Sam's Cloudflare" } });
const draw = (state: GetState, loading: string | null = null): string => renderToStaticMarkup(<GetScreen state={state} on={on} loading={loading} />);
const at = (step: FlowStep, state: GetState = keyed()): GetState => run(state, { type: "go", step });

const EM_DASH = String.fromCharCode(0x2014);

function screens(): Record<string, string> {
  const failedBuild = run(at("build"), { type: "buildStarted" }, { type: "buildStep", step: "Database", state: "done" }, { type: "buildStep", step: "Data layout", state: "failed" }, { type: "buildFailed", step: "Data layout", reason: "Cloudflare would not change the data layout: Cloudflare had a problem on its side." });
  const built = run(at("build"), ...STEP_NAMES.map((step): Action => ({ type: "buildStep", step, state: "done" })), { type: "buildDone", address: ADDRESS });
  return {
    account: draw(initial(null)),
    permission: draw(at("permission", initial(null))),
    permissionOk: draw(at("permission")),
    permissionBad: draw(run(at("permission", initial(null)), { type: "keyTyped", key: KEY }, { type: "keyChecked", key: KEY, check: { kind: "bad", reason: "Cloudflare would not list the accounts: the key was refused, or it lacks a permission this step needs." } })),
    name: draw(run(at("name"), { type: "nameChecked", name: "vemi", check: { kind: "ok", address: ADDRESS } })),
    nameBad: draw(run(at("name"), { type: "nameChecked", name: "vemi", check: { kind: "bad", reason: "This account already has an app called vemi that VEMI did not make." } })),
    build: draw(run(at("build"), { type: "buildStarted" }, { type: "buildStep", step: "Database", state: "done" }, { type: "buildStep", step: "Data layout", state: "start" }), "Getting the VEMI files, 3 of 9"),
    buildFailed: draw(failedBuild),
    built: draw(built),
    update: draw(at("update", built)),
    updateBad: draw(run(at("update", built), { type: "finishFailed", reason: "The new copy is not answering yet. Try again in a minute." })),
    doneKept: draw(run(built, { type: "finished", kept: true })),
    doneOff: draw(run(built, { type: "finished", kept: false })),
  };
}

describe("the setup screens", () => {
  it("each have one h1, which names the step, and the dark side's headline and one line", () => {
    for (const [name, html] of Object.entries(screens())) {
      expect(html.match(/<h1/g), name).toHaveLength(1);
      expect(html.match(/<h2/g), name).toBeNull();
      expect(html, name).toContain('class="get-headline"');
      expect(html, name).toContain('class="get-sub"');
      expect(html, name).toContain('<main class="get-main">');
    }
  });

  it("carry no em-dash, no help button and no undo", () => {
    for (const [name, html] of Object.entries(screens())) {
      const text = html.replace(/<[^>]*>/g, " ");
      expect(text.includes(EM_DASH), name).toBe(false);
      expect(html, name).not.toMatch(/help|undo|redo|\?<\/button>/i);
    }
  });

  it("add only the small i buttons the redesign allows, each named and closed, and no other toggle of a note", () => {
    const all = screens();
    for (const [name, html] of Object.entries(all)) {
      for (const tag of html.match(/<button[^>]*aria-expanded[^>]*>/g) ?? []) {
        expect(tag, name).toContain('class="info-tip-button"');
        expect(tag, name).toMatch(/aria-label="[^"]+"/);
        expect(tag, name).toContain('aria-expanded="false"');
      }
    }
    expect(all["permission"]).toContain(`aria-label="${WORDS.permission.tipLabel}"`);
    expect(all["name"]).toContain(`aria-label="${WORDS.name.tipLabel}"`);
    expect(all["update"]).toContain(`aria-label="${WORDS.update.tipLabel}"`);
    expect(all["doneKept"]).toContain(`aria-label="${WORDS.done.tipLabel}"`);
    expect(all["account"]).not.toContain("info-tip");
  });

  it("say nothing of the key that the page does not do: it never deletes a key, it hands it over or leaves it", () => {
    for (const [name, html] of Object.entries(screens())) {
      const text = html.replace(/<[^>]*>/g, " ");
      expect(text, name).not.toMatch(/deletes? the key|key (is )?(deleted|removed)|removes? the key/i);
    }
    expect(WORDS.update.tip).toContain("handed to your copy");
    expect(WORDS.update.tip).toContain("stays on Cloudflare");
  });

  it("do not name a level", () => {
    for (const [name, html] of Object.entries(screens())) {
      expect(html.replace(/<[^>]*>/g, " "), name).not.toMatch(/\b(space|project|milestone)s?\b/i);
    }
  });

  it("draw five dots for the numbered steps and none on Done", () => {
    const all = screens();
    expect(all["account"]).toContain('aria-label="Step 1 of 5"');
    expect(all["update"]).toContain('aria-label="Step 5 of 5"');
    expect(all["doneKept"]).not.toContain("get-dots");
    expect(all["account"]?.match(/<i[ />]/g)).toHaveLength(5);
  });
});

describe("step 1", () => {
  it("opens Cloudflare's sign-up in a new tab and offers I have one", () => {
    const html = screens()["account"] ?? "";
    expect(html).toContain(WORDS.account.make);
    expect(html).toContain(`href="${SIGN_UP_LINK}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(WORDS.account.have);
  });
});

describe("step 2", () => {
  it("opens the pre-filled permission page and takes a pasted key", () => {
    const html = screens()["permission"] ?? "";
    expect(html).toContain(WORDS.permission.open);
    expect(html).toContain(`href="${tokenLink().replaceAll("&", "&amp;")}"`);
    expect(html).toContain(`placeholder="${WORDS.permission.placeholder}"`);
    expect(html).toMatch(new RegExp(`<label for="get-key">${WORDS.permission.field}</label>`));
    expect(html).toContain('id="get-key"');
  });

  it("says the account's name once the key is checked", () => {
    expect(screens()["permissionOk"]).toContain("Connected to Sam&#x27;s Cloudflare");
  });

  it("says why in one sentence when the key does not work", () => {
    const html = screens()["permissionBad"] ?? "";
    expect(html).toContain("the key was refused");
    expect(html).not.toContain("Connected to");
  });

  it("keeps Next closed until the key is connected", () => {
    expect(screens()["permission"]).toMatch(/<button[^>]*disabled=""[^>]*>Next/);
    expect(screens()["permissionOk"]).not.toMatch(/<button[^>]*disabled=""[^>]*>Next/);
  });

  it("carries the one safety line about the key", () => {
    expect(screens()["permission"]).toContain("This server never stores it.");
  });
});

describe("step 3", () => {
  it("shows the address the copy will have", () => {
    const html = screens()["name"] ?? "";
    expect(html).toContain(WORDS.name.address);
    expect(html).toContain("mine.sub.workers.dev");
    expect(html).toContain(WORDS.name.build);
  });

  it("shows the clash before anything is built", () => {
    const html = screens()["nameBad"] ?? "";
    expect(html).toContain("did not make");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Build my VEMI/);
  });
});

describe("step 4", () => {
  it("lists the six steps in plain words, in order", () => {
    const html = screens()["build"] ?? "";
    const labels = ["Making your database", "Setting up the layout", "Getting the app files ready", "Uploading the app", "Starting the reminder clock", "Giving it an address"];
    let from = 0;
    for (const label of labels) {
      const found = html.indexOf(label, from);
      expect(found, label).toBeGreaterThanOrEqual(from);
      from = found;
    }
    expect(html).toContain("Getting the VEMI files, 3 of 9");
  });

  it("shows the problem with Try again and the Deploy button's link, and keeps what was done", () => {
    const html = screens()["buildFailed"] ?? "";
    expect(html).toContain("Something stopped at setting up the layout");
    expect(html).toContain("Cloudflare had a problem on its side");
    expect(html).toContain(WORDS.build.again);
    expect(html).toContain(`href="${DEPLOY_LINK}"`);
    expect(html).toContain('class="get-row ok"');
    expect(html).toContain('class="get-row bad"');
  });

  it("goes on only when all six are done", () => {
    expect(screens()["buildFailed"]).toMatch(/<button[^>]*disabled=""[^>]*>Next/);
    const built = screens()["built"] ?? "";
    expect(built).toContain(WORDS.build.built);
    expect(built).not.toMatch(/<button[^>]*disabled=""[^>]*>Next/);
  });
});

describe("step 5", () => {
  it("has the switch on by default", () => {
    const html = screens()["update"] ?? "";
    expect(html).toContain(WORDS.update.switch);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
  });

  it("shows the switch off once it is turned off", () => {
    const off = draw(run(at("update"), { type: "keepUpdated", on: false }));
    expect(off).toMatch(/aria-checked="false"/);
  });

  it("holds Finish with a sentence and Try again when the hand-over fails", () => {
    const html = screens()["updateBad"] ?? "";
    expect(html).toContain("The new copy is not answering yet.");
    expect(html).toContain(WORDS.update.again);
  });
});

describe("Done", () => {
  it("opens the new address", () => {
    const html = screens()["doneKept"] ?? "";
    expect(html).toContain(WORDS.done.open);
    expect(html).toContain(`href="${ADDRESS}"`);
  });

  it("says nothing about the key when the copy keeps it", () => {
    expect(screens()["doneKept"]).not.toContain("VEMI setup");
    expect(screens()["doneKept"]).not.toContain(KEY_LIST_LINK);
  });

  it("shows the link and says plainly it could not remove the key when the switch was off", () => {
    const html = screens()["doneOff"] ?? "";
    expect(html).toContain(WORDS.done.keyLeft);
    expect(html).toContain(`href="${KEY_LIST_LINK}"`);
    expect(html).not.toMatch(/deleted|removed your key/i);
  });
});
