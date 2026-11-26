import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fromLocalMode, fromOldAccount } from "../../shared/setup/getFlow.js";
import { initial } from "../get/getFlowState.js";
import { LOCAL_MOVE_HREF, MoveStartView, lines, type MovePhase } from "./MoveStart.js";

const noop = () => undefined;
const draw = (phase: MovePhase, open = true, word = ""): string =>
  renderToStaticMarkup(
    <MoveStartView phase={phase} open={open} address="https://mine.example.workers.dev" code="C" word={word} busy={false}
      onOpen={noop} onAddress={noop} onCode={noop} onWord={noop} onCheck={noop} onReplace={noop} />,
  );

describe("the counts in the person's words", () => {
  const named = { settings: { levelNames: { space: "Realm", task: "Quest" } } };
  it("tells the four levels in the level names the file carries", () => {
    expect(lines({ venture: 2, project: 1, task: 1, tag: 4 }, named)).toEqual(["2 Realms", "1 Project", "1 Quest"]);
  });
  it("falls back to the default words, never a table name", () => {
    const out = lines({ venture: 1, task: 3 }, {}).join(" ");
    expect(out).not.toMatch(/venture|:/);
  });
});

describe("MoveStartView", () => {
  it("offers the helper and an existing copy", () => {
    const out = draw({ kind: "idle" }, false);
    expect(out).toContain(`href="${LOCAL_MOVE_HREF}"`);
    const query = LOCAL_MOVE_HREF.slice(LOCAL_MOVE_HREF.indexOf("?"));
    const opened = initial(null, false, fromOldAccount(query), fromLocalMode(query));
    expect(opened.withMove).toBe(true);
    expect(opened.hasSource).toBe(false);
    expect(opened.fromOld).toBe(false);
    expect(out).toContain("Move to my own cloud");
    expect(out).toContain("I already have a copy");
    expect(out).not.toContain("Copy address");
  });

  it("asks for the copy's address and a move code", () => {
    const out = draw({ kind: "idle" });
    expect(out).toContain('aria-label="Copy address"');
    expect(out).toContain('aria-label="Move code"');
  });

  it("shows both lists and goes on only when replace is typed", () => {
    const out = draw({ kind: "preview", here: ["task: 2"], there: ["task: 5"] });
    expect(out).toContain("This replaces what is in that copy");
    expect(out).toContain("task: 2");
    expect(out).toContain("task: 5");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Replace that copy</);
  });

  it("enables the button once replace is typed", () => {
    const out = draw({ kind: "preview", here: [], there: [] }, true, "replace");
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Replace that copy</);
  });

  it("shows the counts that moved", () => {
    expect(draw({ kind: "done", moved: ["task: 2"] })).toContain("task: 2");
  });

  it("shows one sentence for a stop", () => {
    expect(draw({ kind: "stopped", reason: "That address is not a VEMI copy." })).toContain("That address is not a VEMI copy.");
  });

  it("holds no em-dash", () => {
    for (const p of [{ kind: "idle" }, { kind: "preview", here: [], there: [] }] as MovePhase[]) {
      expect(draw(p)).not.toContain(String.fromCharCode(0x2014));
    }
  });
});
