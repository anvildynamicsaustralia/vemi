import { describe, expect, it } from "vitest";
import { pinEdit, stageEdit } from "./projectHeadEdits.js";

describe("pinEdit", () => {
  it("pins an unpinned project and keeps null as the way back", () => {
    expect(pinEdit({ name: "Vemi", pinnedAt: null }, "2026-11-17T01:00:00Z")).toEqual({
      fields: { pinnedAt: "2026-11-17T01:00:00Z" }, current: { pinnedAt: null }, what: "pinned Vemi",
    });
  });
  it("unpins a pinned project and keeps the stamp as the way back", () => {
    expect(pinEdit({ name: "Vemi", pinnedAt: "2026-11-01T00:00:00Z" }, "x")).toEqual({
      fields: { pinnedAt: null }, current: { pinnedAt: "2026-11-01T00:00:00Z" }, what: "unpinned Vemi",
    });
  });
});

describe("stageEdit", () => {
  it("sets a stage with the old one as the way back", () => {
    expect(stageEdit({ name: "Vemi", stageId: "a" }, "b")).toEqual({
      fields: { stageId: "b" }, current: { stageId: "a" }, what: "changed the stage of Vemi",
    });
  });
  it("clears a stage with null", () => {
    expect(stageEdit({ name: "Vemi", stageId: "a" }, null)?.fields).toEqual({ stageId: null });
  });
  it("does nothing when the stage is the same", () => {
    expect(stageEdit({ name: "Vemi", stageId: null }, null)).toBeNull();
  });
});
