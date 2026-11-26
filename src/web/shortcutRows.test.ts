import { describe, expect, it } from "vitest";
import { levelWords } from "./levelWords.js";
import { shortcutRows } from "./shortcutRows.js";

describe("the shortcuts sheet's rows", () => {
  it("list every key while the single-key switch is on", () => {
    const keys = shortcutRows("Ctrl", levelWords(), true).map((r) => r[0]);
    expect(keys).toEqual(["Ctrl K", "/", "N", "P", "G then M", "G then T", "G then S", "G then A", "1  2", "?", "Esc"]);
  });

  it("list only the palette key and Esc while it is off", () => {
    expect(shortcutRows("Ctrl", levelWords(), false)).toEqual([
      ["Ctrl K", "Open or close the palette"],
      ["Esc", "Close the top layer"],
    ]);
  });

  it("read the level words a person chose", () => {
    const rows = shortcutRows("Ctrl", levelWords({ task: "Job", project: "Build", space: "Yard" }), true);
    expect(rows.find((r) => r[0] === "N")?.[1]).toBe("New job");
    expect(rows.find((r) => r[0] === "1  2")?.[1]).toBe("Board and builds, inside a yard");
  });
});
