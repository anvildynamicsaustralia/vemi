import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENCRYPTED_FIELDS,
  type EncryptedKind,
  envelopeLimit,
  isEnvelopeShape,
  openRecord,
  sealRecord,
} from "./encryptedFields.js";
import { seal } from "./crypto/index.js";

const REF = "AAAAAAAAAAA";
const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

function sample(kind: EncryptedKind): Record<string, unknown> {
  const row: Record<string, unknown> = { id: "row-1", position: 3 };
  for (const field of ENCRYPTED_FIELDS[kind]) row[field] = `${field} of ${kind} é`;
  if (kind === "tasks") row["checklist"] = [{ text: "one", done: false }, { text: "two", done: true }];
  if (kind === "settings") delete row["id"];
  return row;
}

describe("ENCRYPTED_FIELDS", () => {
  const kinds = Object.keys(ENCRYPTED_FIELDS) as EncryptedKind[];

  it.each(kinds)("round trips %s", async (kind) => {
    const key = await newKey();
    const row = sample(kind);
    const sealed = await sealRecord(key, REF, kind, row);
    expect(sealed.failed).toEqual([]);
    for (const field of ENCRYPTED_FIELDS[kind] as readonly string[]) {
      expect(isEnvelopeShape(sealed.row[field] as string)).toBe(true);
    }
    expect(sealed.row["position"]).toBe(row["position"]);
    const opened = await openRecord(key, REF, kind, sealed.row);
    expect(opened.failed).toEqual([]);
    expect(opened.row).toEqual(row);
  });

  it("seals each checklist item on its own", async () => {
    const key = await newKey();
    const sealed = await sealRecord(key, REF, "tasks", sample("tasks"));
    const items = sealed.row["checklist"] as { text: string; done: boolean }[];
    expect(items.map((i) => isEnvelopeShape(i.text))).toEqual([true, true]);
    expect(items.map((i) => i.done)).toEqual([false, true]);
  });

  it("walks a checklist held as JSON text", async () => {
    const key = await newKey();
    const row = { id: "t1", title: "a", checklist: JSON.stringify([{ text: "x", done: false }]) };
    const sealed = await sealRecord(key, REF, "tasks", row);
    const opened = await openRecord(key, REF, "tasks", sealed.row);
    expect(opened.row).toEqual(row);
  });

  it("refuses a field swapped to another field", async () => {
    const key = await newKey();
    const sealed = await sealRecord(key, REF, "decisions", { id: "d1", title: "title", body: "body" });
    const swapped = { ...sealed.row, title: sealed.row["body"], body: sealed.row["title"] };
    const opened = await openRecord(key, REF, "decisions", swapped);
    expect(opened.failed).toEqual(["title", "body"]);
    expect(opened.row["title"]).toBe(swapped.title);
  });

  it("refuses a value moved to another record", async () => {
    const key = await newKey();
    const sealed = await sealRecord(key, REF, "tags", { id: "a", name: "one" });
    const opened = await openRecord(key, REF, "tags", { ...sealed.row, id: "b" });
    expect(opened.failed).toEqual(["name"]);
  });

  it("leaves a value already sealed under this key ref untouched", async () => {
    const key = await newKey();
    const already = await seal(key, REF, "x", { record: "t1", field: "title" });
    const sealed = await sealRecord(key, REF, "tasks", { id: "t1", title: already });
    expect(sealed.row["title"]).toBe(already);
  });

  it("leaves a locked field's envelope alone when opening", async () => {
    const key = await newKey();
    const locked = await seal(key, REF, "secret", { record: "n1", field: "notes.body" });
    const opened = await openRecord(key, REF, "notes", { id: "n1", body: locked });
    expect(opened.row["body"]).toBe(locked);
    expect(opened.failed).toEqual([]);
  });

  it("does not mistake plain text for an envelope", async () => {
    expect(isEnvelopeShape("v1.2 release")).toBe(false);
    const key = await newKey();
    const sealed = await sealRecord(key, REF, "tasks", { id: "t1", title: "v1.2 release" });
    expect(isEnvelopeShape(sealed.row["title"] as string)).toBe(true);
    const opened = await openRecord(key, REF, "tasks", { id: "t1", title: "v1.2 release" });
    expect(opened.row["title"]).toBe("v1.2 release");
    expect(opened.failed).toEqual([]);
  });

  it("names a field that fails to open and returns it as it was", async () => {
    const key = await newKey();
    const other = await newKey();
    const sealed = await sealRecord(other, REF, "tags", { id: "a", name: "one" });
    const opened = await openRecord(key, REF, "tags", sealed.row);
    expect(opened.failed).toEqual(["name"]);
    expect(opened.row["name"]).toBe(sealed.row["name"]);
  });
});

describe("envelopeLimit", () => {
  it("holds a 300 unit title of the widest text", async () => {
    const key = await newKey();
    for (const title of ["\u{1F600}".repeat(150), "€".repeat(300)]) {
      expect(title.length).toBe(300);
      const sealed = await sealRecord(key, REF, "tasks", { id: "t1", title });
      expect((sealed.row["title"] as string).length).toBeLessThanOrEqual(envelopeLimit(300));
    }
  });

  it("has no em-dash in this module", () => {
    for (const name of ["./encryptedFields.ts", "./encryptedFields.test.ts"]) {
      expect(readFileSync(new URL(name, import.meta.url), "utf8").includes(String.fromCharCode(0x2014))).toBe(false);
    }
  });
});
