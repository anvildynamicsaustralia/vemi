import { describe, expect, it } from "vitest";
import { type Bytes, keysFrom, lockBinding, seal } from "@vemi/shared";
import { countSealed, exportName, unlockExport } from "./exportLocked.js";

describe("exportName", () => {
  it("names the file for the person's own day, not the UTC date of the stamp", () => {
    const doc = { exportedAt: "2026-11-23T17:36:00.000Z" };
    expect(exportName(doc, "Australia/Sydney")).toBe("vemi-export-2026-11-24.json");
    expect(exportName(doc, "America/Los_Angeles")).toBe("vemi-export-2026-11-23.json");
  });
  it("falls back to file when the stamp is missing", () => {
    expect(exportName({})).toBe("vemi-export-file.json");
  });
});

const SECRET = "the safe code is 4821";

async function world() {
  const keys = await keysFrom(new Uint8Array(32).fill(0x21) as Bytes);
  const note = await seal(keys.fieldKey, keys.keyRef, SECRET, lockBinding("notes", "n1", "body"));
  const brief = await seal(keys.fieldKey, keys.keyRef, "for my sister", lockBinding("projects", "p1", "whoFor"));
  const document = {
    format: "vemi-export", version: 2, exportedAt: "2026-11-19T00:00:00Z", about: "", settings: {},
    tables: {
      project: [{ id: "p1", name: "Shed", who_for: brief, description: "plain" }],
      note: [{ id: "n1", project_id: "p1", body: note }, { id: "n2", project_id: "p1", body: "v1.2 beta" }],
      task: [{ id: "t1", title: "Mend", body: null }],
    },
  };
  return { keys, document, note, brief };
}

describe("counting locked content in an export", () => {
  it("counts sealed fields only, not text that starts like one", async () => {
    const { document } = await world();
    expect(countSealed(document)).toBe(2);
    expect(countSealed({ tables: {} })).toBe(0);
  });
});

describe("unlocking an export to text", () => {
  it("opens each sealed field under its own record and leaves the rest as it was", async () => {
    const { keys, document } = await world();
    const out = await unlockExport(document, keys);
    expect(out.left).toBe(0);
    const tables = out.document["tables"] as Record<string, Record<string, unknown>[]>;
    expect(tables["note"]?.[0]?.["body"]).toBe(SECRET);
    expect(tables["note"]?.[1]?.["body"]).toBe("v1.2 beta");
    expect(tables["project"]?.[0]).toMatchObject({ who_for: "for my sister", description: "plain" });
    expect(tables["task"]?.[0]?.["body"]).toBeNull();
  });
  it("keeps a field it cannot open locked and counts it", async () => {
    const { document } = await world();
    const other = await keysFrom(new Uint8Array(32).fill(0x99) as Bytes);
    const out = await unlockExport(document, other);
    expect(out.left).toBe(2);
    expect(JSON.stringify(out.document)).not.toContain(SECRET);
    expect(out.document["tables"]).toEqual(document.tables);
  });
  it("does not change the document it was given", async () => {
    const { keys, document } = await world();
    const before = JSON.stringify(document);
    await unlockExport(document, keys);
    expect(JSON.stringify(document)).toBe(before);
  });
});
