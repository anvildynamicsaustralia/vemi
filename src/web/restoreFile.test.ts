import { describe, expect, it } from "vitest";
import { countLines, deletionDay, readRestoreFile } from "./restoreFile.js";

const file = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: "vemi-export", version: 2, exportedAt: "2026-11-01T00:00:00.000Z", about: "x", settings: {}, tables: { task: [{ id: "a" }, { id: "b" }] }, ...over });

describe("readRestoreFile", () => {
  it("reads an export and keeps the document whole", () => {
    const read = readRestoreFile(file());
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.document["version"]).toBe(2);
  });

  it("reads a version 1 file", () => {
    expect(readRestoreFile(file({ version: 1 })).ok).toBe(true);
  });

  it("refuses text that is not JSON", () => {
    expect(readRestoreFile("not json")).toEqual({ ok: false, error: "This is not a VEMI export file." });
  });

  it("refuses JSON that is not an export", () => {
    expect(readRestoreFile(file({ format: "other" })).ok).toBe(false);
    expect(readRestoreFile("[]").ok).toBe(false);
  });

  it("refuses a version it cannot read", () => {
    expect(readRestoreFile(file({ version: 9 })).ok).toBe(false);
  });

  it("refuses a file with no tables", () => {
    expect(readRestoreFile(file({ tables: undefined })).ok).toBe(false);
  });
});

describe("countLines", () => {
  it("lists what a file holds, by name, leaving out what is empty", () => {
    expect(countLines({ task: 2, project_note: 0, venture: 1 })).toEqual(["task: 2", "venture: 1"]);
  });

  it("says nothing for an empty file", () => {
    expect(countLines({})).toEqual([]);
  });
});

describe("deletionDay", () => {
  it("names the day in words", () => {
    expect(deletionDay("2026-11-26T10:00:00.000Z")).toBe("26 November");
  });
});
