import { beforeEach, describe, expect, it } from "vitest";
import { archiveFind, archiveFound, findInArchive } from "./archiveFind.js";

describe("archiveFind", () => {
  beforeEach(() => archiveFound());

  it("opens the Archive's field holding what Search was given, trimmed", () => {
    findInArchive("  dingo ");
    expect(archiveFind()).toBe("dingo");
    // Read twice, as a first draw may be, it still holds.
    expect(archiveFind()).toBe("dingo");
  });

  it("opens empty once the Archive has taken it, or when nothing was handed over", () => {
    expect(archiveFind()).toBe("");
    findInArchive("dingo");
    archiveFound();
    expect(archiveFind()).toBe("");
    findInArchive("   ");
    expect(archiveFind()).toBe("");
  });
});
