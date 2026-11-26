import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./useMedia.js", () => ({ PHONE: "", useMedia: () => false }));

import { LockableText, LockableView, wasFor, type LockPhase } from "./LockableText.js";

const DASH = String.fromCharCode(0x2014);
const none = (): void => undefined;
const SEALED = `v1.${"A".repeat(11)}.${"B".repeat(16)}.${"C".repeat(40)}`;

const view = (phase: LockPhase, extra: { panel?: string | null; tip?: string | null; problem?: string | null } = {}): string =>
  renderToStaticMarkup(
    <LockableView phase={phase} editor={<p>the editor</p>} panel={extra.panel === undefined || extra.panel === null ? null : <p>{extra.panel}</p>}
      tip={extra.tip ?? null} problem={extra.problem ?? null} onLock={none} onUnlock={none} onOpen={none} onCancel={none} />,
  );

describe("LockableText", () => {
  it("wraps a plain field in its editor with a lock button", () => {
    const out = renderToStaticMarkup(
      <LockableText kind="tasks" id="t1" field="body" value="Some words" save={none}>
        {(editor) => <p>{editor.value}</p>}
      </LockableText>,
    );
    expect(out).toContain("Some words");
    expect(out).toContain('aria-label="Lock"');
    expect(out).not.toContain(DASH);
  });

  it("offers no lock on an empty field", () => {
    const out = renderToStaticMarkup(
      <LockableText kind="projects" id="p1" field="whoFor" value={null} save={none}>
        {(editor) => <p>{editor.value ?? "empty"}</p>}
      </LockableText>,
    );
    expect(out).toContain("empty");
    expect(out).not.toContain('aria-label="Lock"');
  });

  it("does not draw the envelope while a locked field is being read", () => {
    const out = renderToStaticMarkup(
      <LockableText kind="tasks" id="t1" field="body" value={SEALED} save={none}>
        {(editor) => <p>{editor.value}</p>}
      </LockableText>,
    );
    expect(out).not.toContain(SEALED);
    expect(out).not.toContain("v1.");
  });
});

describe("LockableView", () => {
  it("plain: the editor and a Lock button", () => {
    const out = view({ at: "plain", text: "hello" });
    expect(out).toContain("the editor");
    expect(out).toContain('aria-label="Lock"');
    expect(out).not.toContain("Unlock for good");
    expect(out).not.toContain("Locked");
  });

  it("plain and empty: no Lock button", () => {
    expect(view({ at: "plain", text: null })).not.toContain('aria-label="Lock"');
  });

  it("plain: the tip stands beside the lock", () => {
    const out = view({ at: "plain", text: "hello" }, { tip: "TIP" });
    expect(out).toContain("TIP");
  });

  it("open: reads normally with a small lock mark and Unlock for good", () => {
    const out = view({ at: "open", text: "hello" }, { tip: "TIP" });
    expect(out).toContain("the editor");
    expect(out).toContain('role="img" aria-label="Locked"');
    expect(out).toContain(">Unlock for good</button>");
    expect(out).not.toContain('aria-label="Lock"');
    expect(out).not.toContain("TIP");
  });

  it("closed: a lock, Locked and Open, and no editor", () => {
    const out = view({ at: "closed" });
    expect(out).toContain("Locked");
    expect(out).toContain(">Open</button>");
    expect(out).not.toContain("the editor");
  });

  it("closed with the way in open: the way in stands in place of Open", () => {
    const out = view({ at: "closed" }, { panel: "the way in" });
    expect(out).toContain("the way in");
    expect(out).not.toContain(">Open</button>");
    expect(out).toContain(">Not now</button>");
  });

  it("no key to set up: the setup stands in place of the editor", () => {
    const out = view({ at: "plain", text: "hello" }, { panel: "the setup" });
    expect(out).toContain("the setup");
    expect(out).not.toContain("the editor");
  });

  it("damaged: says so and offers no Open", () => {
    const out = view({ at: "damaged" });
    expect(out).not.toContain(">Open</button>");
  });

  it("says a problem in an alert", () => {
    expect(view({ at: "open", text: "x" }, { problem: "Didn't work." })).toContain('role="alert"');
  });

  it("never carries an em-dash or an instruction sentence", () => {
    for (const phase of [{ at: "plain", text: "x" }, { at: "open", text: "x" }, { at: "closed" }] as const) {
      const out = view(phase);
      expect(out).not.toContain(DASH);
      expect(out).not.toMatch(/click|tap|press|you can/i);
    }
  });
});

describe("wasFor", () => {
  it("sends the stored envelope, never the plain text, as the way back for an open locked field", () => {
    expect(wasFor(true, SEALED, "plain words")).toBe(SEALED);
    expect(wasFor(true, SEALED, "plain words")).not.toContain("plain words");
  });

  it("sends the text on screen for an ordinary field", () => {
    expect(wasFor(false, "stored", "shown")).toBe("shown");
  });
});
