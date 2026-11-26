import { keysFrom, lockBinding, makeAccountKey, open, seal } from "@vemi/shared";
import { describe, expect, it } from "vitest";
import { countEnvelopes, restoreReseal, type ResealPatch } from "./restoreReseal.js";

/** A file from an encrypted account is restored under new ids: every envelope is resealed to its row's new id and opens there. */

async function world() {
  const { fieldKey, keyRef } = await keysFrom(makeAccountKey());
  const other = await keysFrom(makeAccountKey());
  const key = { fieldKey, keyRef };
  const typed = (record: string, field: string, text: string) => seal(fieldKey, keyRef, text, { record, field });
  const document = {
    tables: {
      key_wrap: [{ id: "k1", key_ref: keyRef }],
      venture: [{ id: "v-old", name: await typed("v-old", "name", "Workshop"), description: null }],
      project: [{
        id: "p-old", venture_id: "v-old", name: await typed("p-old", "name", "Shed"),
        // A locked field is bound by the lock's own binding, a typed one by its column.
        who_for: await seal(fieldKey, keyRef, "Locked brief", lockBinding("projects", "p-old", "whoFor")),
        done_looks: await typed("p-old", "doneLooks", "Typed brief"),
      }],
      task: [{
        id: "t-old", title: await typed("t-old", "title", "Mend the gate"),
        body: await seal(fieldKey, keyRef, "Locked body", lockBinding("tasks", "t-old", "body")),
        checklist: JSON.stringify([{ text: await typed("t-old", "checklist.text", "Buy hinges"), done: true }, { text: "plain step", done: false }]),
      }],
      note: [
        { id: "n-old", body: await typed("n-old", "body", "Typed note") },
        // Sealed under another key: this key cannot open it under either id.
        { id: "n2-old", body: await seal(other.fieldKey, other.keyRef, "Someone else's", { record: "n2-old", field: "body" }) },
      ],
      saved_filter: [{ id: "f-old", name: await typed("f-old", "name", "Gate work"), query: await typed("f-old", "query", "gate") }],
    },
  };
  const ids = { "v-old": "v-new", "p-old": "p-new", "t-old": "t-new", "n-old": "n-new", "n2-old": "n2-new", "f-old": "f-new" };
  return { key, document, ids, other };
}

function steps() {
  const saved: ResealPatch[] = [];
  const replaced: { restored: string; fresh: string; name: string; query: string }[] = [];
  return {
    saved, replaced,
    steps: {
      save: async (p: ResealPatch) => { saved.push(p); },
      replaceFilter: async (restored: string, fresh: string, f: { name: string; query: string }) => { replaced.push({ restored, fresh, ...f }); },
    },
  };
}

describe("restoreReseal", () => {
  it("moves every envelope to the new id so a locked field and a typed field both open there", async () => {
    const w = await world();
    const s = steps();
    const out = await restoreReseal(w.document, w.ids, w.key, s.steps);
    expect(out.left).toBe(1);
    const get = (kind: string, id: string) => s.saved.find((p) => p.kind === kind && p.id === id)?.fields;

    const project = get("projects", "p-new") as Record<string, string>;
    expect(await open(w.key.fieldKey, project["whoFor"] as string, lockBinding("projects", "p-new", "whoFor"))).toBe("Locked brief");
    expect(await open(w.key.fieldKey, project["doneLooks"] as string, { record: "p-new", field: "doneLooks" })).toBe("Typed brief");
    await expect(open(w.key.fieldKey, project["whoFor"] as string, lockBinding("projects", "p-old", "whoFor"))).rejects.toThrow();

    const task = get("tasks", "t-new") as Record<string, string | { text: string; done: boolean }[]>;
    expect(await open(w.key.fieldKey, task["title"] as string, { record: "t-new", field: "title" })).toBe("Mend the gate");
    expect(await open(w.key.fieldKey, task["body"] as string, lockBinding("tasks", "t-new", "body"))).toBe("Locked body");
    const items = task["checklist"] as { text: string; done: boolean }[];
    expect(await open(w.key.fieldKey, items[0]!.text, { record: "t-new", field: "checklist.text" })).toBe("Buy hinges");
    expect(items[0]!.done).toBe(true);
    expect(items[1]).toEqual({ text: "plain step", done: false });

    const note = get("notes", "n-new") as Record<string, string>;
    expect(await open(w.key.fieldKey, note["body"] as string, { record: "n-new", field: "body" })).toBe("Typed note");
    expect(await open(w.key.fieldKey, (get("ventures", "v-new") as Record<string, string>)["name"] as string, { record: "v-new", field: "name" })).toBe("Workshop");
  });

  it("makes a saved filter again under its own fresh id, with both envelopes bound to it", async () => {
    const w = await world();
    const s = steps();
    await restoreReseal(w.document, w.ids, w.key, s.steps);
    const [made] = s.replaced;
    expect(made?.restored).toBe("f-new");
    expect(await open(w.key.fieldKey, made!.name, { record: made!.fresh, field: "name" })).toBe("Gate work");
    expect(await open(w.key.fieldKey, made!.query, { record: made!.fresh, field: "query" })).toBe("gate");
  });

  it("leaves a field that opens under neither id as it is, and counts it", async () => {
    const w = await world();
    const s = steps();
    const out = await restoreReseal(w.document, w.ids, w.key, s.steps);
    expect(out.left).toBe(1);
    expect(s.saved.find((p) => p.id === "n2-new")).toBeUndefined();
  });

  it("does not touch a field that already opens under the new id, and sends nothing but envelopes", async () => {
    const w = await world();
    const s = steps();
    const done = { tables: { note: [{ id: "n-new", body: await seal(w.key.fieldKey, w.key.keyRef, "Moved already", { record: "n-new", field: "body" }) }] } };
    const out = await restoreReseal(done, { "n-new": "n-new" }, w.key, s.steps);
    expect(out).toEqual({ resealed: 0, left: 0 });
    expect(s.saved).toEqual([]);
    await restoreReseal(w.document, w.ids, w.key, s.steps);
    const sent = JSON.stringify([s.saved, s.replaced]);
    for (const plain of ["Workshop", "Shed", "Mend the gate", "Typed note", "Locked brief", "Buy hinges", "Gate work"]) expect(sent).not.toContain(plain);
  });

  it("counts envelopes in a file without opening any", async () => {
    const w = await world();
    // venture 1, project 3, task 3 (title, body, one step), notes 2, filter 2.
    expect(countEnvelopes(w.document)).toBe(11);
  });
});
