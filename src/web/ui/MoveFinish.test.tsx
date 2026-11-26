import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Bytes, keysFrom, lockBinding, seal } from "@vemi/shared";
import { FINISHING, PASSKEY_LINE, lockedHeld } from "../moveLocked.js";
import { MoveFinish, MoveFinishView } from "./MoveFinish.js";

const EM_DASH = String.fromCharCode(0x2014);

async function file(lockedRow: boolean) {
  const keys = await keysFrom(new Uint8Array(32).fill(0x31) as Bytes);
  const body = lockedRow ? await seal(keys.fieldKey, keys.keyRef, "secret", lockBinding("notes", "n1", "body")) : "plain";
  const title = await seal(keys.fieldKey, keys.keyRef, "typed", { record: "t1", field: "title" });
  return {
    format: "vemi-export",
    tables: {
      note: [{ id: "n1", body }], task: [{ id: "t1", title }],
      key_wrap: [{ id: "k", key_ref: keys.keyRef, key_check: keys.keyCheck, kind: "recovery", label: "Recovery", wrapped: "x", created_at: "t", archived_at: null }],
    },
  };
}

describe("Finishing your locked notes", () => {
  it("asks for one of the file's own ways in, under its name", async () => {
    const html = renderToStaticMarkup(<MoveFinishView held={lockedHeld(await file(true))} phase={{ kind: "ask" }} onProve={() => {}} />);
    expect(html).toContain(FINISHING);
    expect(html).not.toContain(EM_DASH);
  });

  it("shows the passkey line only when the file held a locked row", async () => {
    const done = { kind: "done", resealed: 2, left: 0, said: null } as const;
    const withLock = renderToStaticMarkup(<MoveFinishView held={lockedHeld(await file(true))} phase={done} onProve={() => {}} />);
    const typedOnly = renderToStaticMarkup(<MoveFinishView held={lockedHeld(await file(false))} phase={done} onProve={() => {}} />);
    expect(withLock).toContain(PASSKEY_LINE);
    expect(typedOnly).not.toContain(PASSKEY_LINE);
  });

  it("says a left cell in one sentence and shows work in progress", async () => {
    const held = lockedHeld(await file(true));
    const said = "1 locked item could not be opened and stays as the file had it.";
    expect(renderToStaticMarkup(<MoveFinishView held={held} phase={{ kind: "done", resealed: 1, left: 1, said }} onProve={() => {}} />)).toContain(said);
    expect(renderToStaticMarkup(<MoveFinishView held={held} phase={{ kind: "working" }} onProve={() => {}} />)).toContain('role="status"');
  });

  it("draws nothing for a file with nothing locked", () => {
    const html = renderToStaticMarkup(
      <MoveFinish account="a" document={{ tables: { note: [{ id: "n", body: "plain" }] } }} loadCopy={async () => ({})}
        steps={{ save: async () => {}, replaceFilter: async () => {} }} />,
    );
    expect(html).toBe("");
  });
});
