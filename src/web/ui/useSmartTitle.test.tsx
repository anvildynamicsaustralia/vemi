import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { restoreWords, smartOf, useSmartTitle } from "./useSmartTitle.js";

const NOW = new Date("2026-11-17T01:00:00Z");
const ZONE = "Australia/Sydney";
const ON = { getItem: () => null };

describe("smartOf", () => {
  it("splits a title into the title, what it means and chips", () => {
    const s = smartOf("call vet tomorrow at 3pm", "", NOW, ZONE, ON);
    expect(s.title).toBe("call vet");
    expect(s.picked).toEqual({ dueOn: "2026-11-18", repeat: null, remindAt: "2026-11-18T15:00" });
    expect(s.chips.map((c) => c.words)).toEqual(["tomorrow", "at 3pm"]);
  });
  it("carries a repeat and no date", () => {
    const s = smartOf("bins every friday", "", NOW, ZONE, ON);
    expect(s.title).toBe("bins");
    expect(s.picked).toEqual({ dueOn: null, repeat: "week:5", remindAt: null });
  });
  it("leaves plain text alone", () => {
    const s = smartOf("buy milk", "", NOW, ZONE, ON);
    expect(s).toMatchObject({ title: "buy milk", chips: [], picked: { dueOn: null, repeat: null, remindAt: null } });
  });
  it("does not read words that were put back", () => {
    const s = smartOf("call vet tomorrow", "call vet tomorrow", NOW, ZONE, ON);
    expect(s.title).toBe("call vet tomorrow");
    expect(s.chips).toEqual([]);
  });
  it("still reads what is typed after words that were put back", () => {
    const s = smartOf("call vet tomorrow at 3pm", "call vet tomorrow", NOW, ZONE, ON);
    expect(s.title).toBe("call vet tomorrow");
    expect(s.picked.remindAt).not.toBeNull();
  });
  it("reads nothing when the switch is off", () => {
    const s = smartOf("call vet tomorrow", "", NOW, ZONE, { getItem: () => "off" });
    expect(s).toMatchObject({ title: "call vet tomorrow", chips: [] });
  });
});

describe("restoreWords", () => {
  it("puts a chip's words back on the end of the title", () => {
    const s = smartOf("call vet tomorrow", "", NOW, ZONE, ON);
    expect(restoreWords(s.title, s.chips[0]!)).toBe("call vet tomorrow");
  });
});

describe("useSmartTitle", () => {
  it("starts from the text it is given", () => {
    function Probe() {
      const s = useSmartTitle("bins every friday");
      return <p data-title={s.title} data-text={s.text} data-chips={s.chips.length} />;
    }
    const out = renderToStaticMarkup(<Probe />);
    expect(out).toContain('data-text="bins every friday"');
    expect(out).toContain('data-title="bins"');
    expect(out).toContain('data-chips="1"');
  });
});
