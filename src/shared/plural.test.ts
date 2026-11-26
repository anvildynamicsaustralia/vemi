import { describe, expect, it } from "vitest";
import { pluralOf } from "./plural.js";

describe("pluralOf", () => {
  it("turns a consonant and y into ies", () => {
    expect(pluralOf("Study")).toBe("Studies");
    expect(pluralOf("Day")).toBe("Days");
  });
  it("adds es after s, x, z, ch and sh", () => {
    expect(pluralOf("Class")).toBe("Classes");
    expect(pluralOf("Box")).toBe("Boxes");
    expect(pluralOf("Bench")).toBe("Benches");
    expect(pluralOf("Wish")).toBe("Wishes");
  });
  it("adds s to the rest", () => {
    expect(pluralOf("Task")).toBe("Tasks");
  });
});
