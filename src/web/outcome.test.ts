import { describe, expect, it } from "vitest";
import { isQueued, outcomeOf, wasKept } from "./outcome.js";

const kept = { queued: true } as const;
const record = { id: "t1", title: "Glaze" };

describe("the outcome of a write", () => {
  it("is sent when the Worker answered with the record", () => {
    expect(outcomeOf(record)).toBe("sent");
    expect(outcomeOf(undefined)).toBe("sent");
  });

  it("is kept when this device is holding it", () => {
    expect(isQueued(kept)).toBe(true);
    expect(outcomeOf(kept)).toBe("kept");
  });

  it("is kept for a batch when any write in it was, however it was nested", () => {
    expect(outcomeOf([record, record])).toBe("sent");
    expect(outcomeOf([record, kept])).toBe("kept");
    expect(outcomeOf([[record], [record, [kept]]])).toBe("kept");
    expect(outcomeOf([])).toBe("sent");
  });

  it("is not fooled by a list that merely says queued", () => {
    expect(wasKept({ queued: "yes" })).toBe(false);
    expect(wasKept([null, 0, "queued"])).toBe(false);
  });
});
