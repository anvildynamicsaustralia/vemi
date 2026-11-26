import { describe, expect, it } from "vitest";
import {
  type Bytes,
  hkdf,
  keysFrom,
  parseRecoveryKey,
  sealForPairing,
  toBase64Url,
} from "@vemi/shared";
import type { KeyApi, KeyBundleInput, KeyRow, KeyRowInput, KeyState, PairingAnswer } from "./api.js";
import { ApiError } from "./api.js";
import { deviceKey, memoryShelf } from "./deviceKey.js";
import { type KeyDeps, KeyWayError, deviceLabel, keyWays } from "./keyWays.js";
import { createVault } from "./vault.js";

const ACCOUNT = "a@example.com";
const ACCOUNT_KEY = new Uint8Array(32).fill(0x42) as Bytes;
const PRF = new Uint8Array(32).fill(0x77) as Bytes;
const PASSWORD = "a long vault phrase";
const CREDENTIAL = toBase64Url(new Uint8Array([9, 8, 7, 6]));

/** A stand-in for the Worker that records every body it was sent. */
function fakeWorker() {
  const rows: (KeyRow & { archived: boolean; keyRef: string; keyCheck: string })[] = [];
  const bodies: string[] = [];
  const pairings = new Map<string, { sealed?: string }>();
  let clock = 0;
  const state = (): KeyState => {
    const open = rows.filter((r) => !r.archived);
    return { keyRef: open[0]?.keyRef ?? null, keyCheck: open[0]?.keyCheck ?? null, wraps: open.map(({ archived: _a, keyRef: _r, keyCheck: _c, ...row }) => row) };
  };
  const add = (b: KeyBundleInput): void => {
    for (const w of b.wraps) {
      clock += 1;
      rows.push({ ...w, createdAt: `2026-11-19T00:00:${String(clock).padStart(2, "0")}Z`, archived: false, keyRef: b.keyRef, keyCheck: b.keyCheck });
    }
  };
  const archive = (id: string): void => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new ApiError(404, "That is not here.");
    row.archived = true;
    if (row.kind === "device") for (const r of rows) if (r.deviceId === id) r.archived = true;
  };
  let offline = false;
  const guard = <T>(body: unknown, then: () => T): Promise<T> => {
    bodies.push(JSON.stringify(body ?? null));
    return offline ? Promise.reject(new ApiError(0, "Couldn't reach VEMI.")) : Promise.resolve(then());
  };
  const api: KeyApi = {
    keysNow: () => guard(null, state),
    addKeys: (b) => guard(b, () => {
      const current = state();
      if (current.keyRef !== null && current.keyRef !== b.keyRef) throw new ApiError(409, "Another key is in use.");
      add(b);
      return state();
    }),
    archiveKey: (id) => guard({ id }, () => { archive(id); return state(); }),
    replaceRecovery: (w: KeyRowInput) => guard(w, () => {
      for (const r of rows) if (r.kind === "recovery" && !r.archived) r.archived = true;
      const first = rows.find((r) => !r.archived);
      add({ keyRef: first?.keyRef ?? "", keyCheck: first?.keyCheck ?? "", wraps: [w] });
      return state();
    }),
    startAgain: (b) => guard(b, () => { for (const r of rows) r.archived = true; add(b); return state(); }),
    openPairing: (id) => guard({ id }, () => { pairings.set(id, {}); return { id, expiresAt: "later" }; }),
    fillPairing: (id, parts) => guard(parts, () => {
      const open = pairings.get(id);
      if (!open) throw new ApiError(404, "No such pairing.");
      open.sealed = parts.sealed;
      return { filled: true as const };
    }),
    readPairing: (id) => guard({ id }, (): PairingAnswer => {
      const open = pairings.get(id);
      if (!open) throw new ApiError(404, "No such pairing.");
      if (open.sealed === undefined) return { waiting: true };
      pairings.delete(id);
      return { sealed: open.sealed };
    }),
  };
  return { api, bodies, rows, setOffline: (v: boolean) => { offline = v; } };
}

function device(worker: ReturnType<typeof fakeWorker>, over: Partial<KeyDeps> = {}) {
  const shelf = memoryShelf();
  let n = 0;
  const deps: KeyDeps = {
    api: worker.api,
    shelf,
    passkeys: {
      possible: () => true,
      make: async () => ({ credentialId: CREDENTIAL, output: PRF }),
      output: async (rows) => (rows.some((r) => r.credentialId === CREDENTIAL) ? { credentialId: CREDENTIAL, output: PRF } : null),
    },
    label: "Chrome on Windows",
    makeKey: () => ACCOUNT_KEY,
    newId: () => `id-${Math.random().toString(36).slice(2)}-${(n += 1)}`,
    ...over,
  };
  return { shelf, ways: keyWays(ACCOUNT, deps), deps };
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const forms = (b: Uint8Array): string[] => [hex(b), b64(b), b64(b).replace(/=+$/, ""), toBase64Url(b), String.fromCharCode(...b)];
const textForms = (s: string): string[] => [s, ...forms(new TextEncoder().encode(s))];

async function secretsOf(recoveryText: string[]): Promise<string[]> {
  const field = await hkdf(ACCOUNT_KEY, "vemi:field-key:v1", 32);
  const out = [...forms(ACCOUNT_KEY), ...forms(field), ...forms(PRF), ...textForms(PASSWORD)];
  for (const text of recoveryText) {
    out.push(...textForms(text), ...textForms(text.replace(/-/g, "")), ...forms(await parseRecoveryKey(text)));
  }
  return out;
}

describe("setting up", () => {
  it("makes the key, wraps it for a passkey and a recovery key, lists this device and keeps the field key", async () => {
    const worker = fakeWorker();
    const { ways, shelf } = device(worker);
    const { recoveryKey, opened } = await ways.setUp({ kind: "passkey" });
    expect(recoveryKey).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/);
    const state = await worker.api.keysNow();
    expect(state.wraps.map((w) => w.kind).sort()).toEqual(["device", "passkey", "recovery"]);
    expect(state.keyRef).toBe((await keysFrom(ACCOUNT_KEY)).keyRef);
    expect(opened.kept).toBe(true);
    expect((await deviceKey(ACCOUNT, shelf))?.deviceId).toBe(opened.deviceId);
    const passkey = state.wraps.find((w) => w.kind === "passkey");
    expect(passkey?.deviceId).toBe(opened.deviceId);
  });

  it("sends nothing until save", async () => {
    const worker = fakeWorker();
    const { ways, shelf } = device(worker);
    const pending = await ways.prepareSetUp({ kind: "password", password: PASSWORD });
    expect(worker.bodies).toEqual([]);
    expect(await deviceKey(ACCOUNT, shelf)).toBeNull();
    await pending.save();
    expect(worker.bodies).toHaveLength(1);
  });

  it("refuses a short vault password", async () => {
    const worker = fakeWorker();
    const { ways } = device(worker);
    await expect(ways.prepareSetUp({ kind: "password", password: "short" })).rejects.toMatchObject({ problem: "weak" });
  });

  it("reports a device with no PRF so the vault password can be offered", async () => {
    const worker = fakeWorker();
    const { ways } = device(worker, {
      passkeys: { possible: () => true, make: async () => null, output: async () => null },
    });
    await expect(ways.prepareSetUp({ kind: "passkey" })).rejects.toMatchObject({ problem: "nopasskey" });
  });
});

describe("opening on another device", () => {
  async function ready() {
    const worker = fakeWorker();
    const first = device(worker);
    const { recoveryKey } = await first.ways.setUp({ kind: "passkey" });
    await first.ways.addWay({ kind: "password", password: PASSWORD }, { kind: "passkey" });
    return { worker, first, recoveryKey };
  }

  it("opens with the passkey, the vault password and the recovery key, each listing a device", async () => {
    const { worker, recoveryKey } = await ready();
    for (const way of [
      { kind: "passkey" } as const,
      { kind: "password", password: PASSWORD } as const,
      { kind: "recovery", recoveryKey } as const,
    ]) {
      const other = device(worker);
      const opened = await other.ways.openWith(way);
      expect(opened.kept).toBe(true);
      expect((await deviceKey(ACCOUNT, other.shelf))?.keyRef).toBe((await keysFrom(ACCOUNT_KEY)).keyRef);
    }
    expect((await worker.api.keysNow()).wraps.filter((w) => w.kind === "device")).toHaveLength(4);
  });

  it("refuses a wrong password, a wrong recovery key and a mistyped one, and lists nothing", async () => {
    const { worker, recoveryKey } = await ready();
    const other = device(worker);
    const before = (await worker.api.keysNow()).wraps.length;
    await expect(other.ways.openWith({ kind: "password", password: "not the phrase" })).rejects.toThrow("That didn't work. Try again.");
    await expect(other.ways.openWith({ kind: "recovery", recoveryKey: "AAAA-BBBB" })).rejects.toBeInstanceOf(KeyWayError);
    const typo = recoveryKey.slice(0, -1) + (recoveryKey.endsWith("0") ? "1" : "0");
    await expect(other.ways.openWith({ kind: "recovery", recoveryKey: typo })).rejects.toBeInstanceOf(KeyWayError);
    expect((await worker.api.keysNow()).wraps).toHaveLength(before);
    expect(await deviceKey(ACCOUNT, other.shelf)).toBeNull();
  });

  it("leaves no device row when the browser cannot keep the key", async () => {
    const { worker } = await ready();
    const broken = memoryShelf();
    broken.put = () => Promise.reject(new Error("blocked"));
    const other = device(worker, { shelf: broken });
    const opened = await other.ways.openWith({ kind: "password", password: PASSWORD });
    expect(opened).toMatchObject({ kept: false, deviceId: null });
    expect((await worker.api.keysNow()).wraps.filter((w) => w.kind === "device")).toHaveLength(1);
  });

  it("keeps a filled pairing when the key's rows cannot be had, so the same link still opens it", async () => {
    const { worker, first } = await ready();
    const other = device(worker);
    const handle = await other.ways.startPairing();
    await first.ways.allowPairing({ kind: "password", password: PASSWORD }, handle.id, handle.publicPart);
    worker.setOffline(true);
    await expect(other.ways.finishPairing(handle)).rejects.toThrow();
    worker.setOffline(false);
    expect((await other.ways.finishPairing(handle))?.kept).toBe(true);
  });

  it("opens by pairing and refuses a copy for the wrong pairing or the wrong key", async () => {
    const { worker, first } = await ready();
    const other = device(worker);
    const handle = await other.ways.startPairing();
    expect(await other.ways.finishPairing(handle)).toBeNull();
    await first.ways.allowPairing({ kind: "password", password: PASSWORD }, handle.id, handle.publicPart);
    const opened = await other.ways.finishPairing(handle);
    expect(opened?.kept).toBe(true);
    expect((await deviceKey(ACCOUNT, other.shelf))?.keyRef).toBe((await keysFrom(ACCOUNT_KEY)).keyRef);

    const third = device(worker);
    const again = await third.ways.startPairing();
    // A copy sealed under another pairing id cannot be opened for this one.
    await worker.api.openPairing("some-other-pairing-id");
    await first.ways.allowPairing({ kind: "passkey" }, "some-other-pairing-id", again.publicPart);
    const wrongId = await worker.api.readPairing("some-other-pairing-id");
    if ("waiting" in wrongId) throw new Error("expected a filled pairing");
    await worker.api.fillPairing(again.id, wrongId);
    await expect(third.ways.finishPairing(again)).rejects.toThrow("That didn't work. Try again.");
  });

  it("refuses a pairing sealed with a different key", async () => {
    const { worker } = await ready();
    const other = device(worker);
    const handle = await other.ways.startPairing();
    // A copy of some other key, sealed correctly to this pairing, is caught by the key check.
    await worker.api.fillPairing(handle.id, { sealed: await sealForPairing(new Uint8Array(32).fill(1), handle.publicPart, handle.id) });
    await expect(other.ways.finishPairing(handle)).rejects.toThrow("That didn't work. Try again.");
  });
});

describe("adding and replacing ways in", () => {
  it("adds a passkey on this device only when this device is set up", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    await first.ways.setUp({ kind: "password", password: PASSWORD });
    const empty = device(worker);
    await expect(empty.ways.addWay({ kind: "passkey" }, { kind: "password", password: PASSWORD })).rejects.toMatchObject({ problem: "device" });
    await first.ways.addWay({ kind: "passkey" }, { kind: "password", password: PASSWORD });
    expect((await worker.api.keysNow()).wraps.filter((w) => w.kind === "passkey")).toHaveLength(1);
  });

  it("changing the vault password archives the old row and the old password stops opening", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    await first.ways.setUp({ kind: "password", password: PASSWORD });
    await first.ways.addWay({ kind: "password", password: "a different long phrase" }, { kind: "password", password: PASSWORD });
    expect((await worker.api.keysNow()).wraps.filter((w) => w.kind === "password")).toHaveLength(1);
    const other = device(worker);
    await expect(other.ways.openWith({ kind: "password", password: PASSWORD })).rejects.toBeInstanceOf(KeyWayError);
    await other.ways.openWith({ kind: "password", password: "a different long phrase" });
  });

  it("a new recovery key replaces the old, which then opens nothing", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    const { recoveryKey: old } = await first.ways.setUp({ kind: "password", password: PASSWORD });
    const pending = await first.ways.newRecoveryKey({ kind: "password", password: PASSWORD });
    const before = worker.bodies.length;
    expect(pending.recoveryKey).not.toBe(old);
    await pending.save();
    expect(worker.bodies.length).toBe(before + 1);
    await expect(device(worker).ways.openWith({ kind: "recovery", recoveryKey: old })).rejects.toBeInstanceOf(KeyWayError);
    await device(worker).ways.openWith({ kind: "recovery", recoveryKey: pending.recoveryKey });
  });

  it("starting again archives every old row and old ways stop opening", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    const { recoveryKey: old } = await first.ways.setUp({ kind: "password", password: PASSWORD });
    const again = device(worker, { makeKey: () => new Uint8Array(32).fill(0x24) as Bytes });
    const pending = await again.ways.prepareStartAgain({ kind: "password", password: "the next long phrase" });
    await pending.save();
    expect(worker.rows.filter((r) => !r.archived).every((r) => r.keyRef === (worker.rows.at(-1)?.keyRef))).toBe(true);
    expect(worker.rows.some((r) => r.archived)).toBe(true);
    await expect(device(worker).ways.openWith({ kind: "recovery", recoveryKey: old })).rejects.toBeInstanceOf(KeyWayError);
    await device(worker).ways.openWith({ kind: "recovery", recoveryKey: pending.recoveryKey });
  });
});

describe("checking this device", () => {
  it("keeps the key while its row is live", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    await first.ways.setUp({ kind: "passkey" });
    expect(await first.ways.checkDevice()).toBe("kept");
    expect(await deviceKey(ACCOUNT, first.shelf)).not.toBeNull();
  });

  it("says none when nothing is kept", async () => {
    expect(await device(fakeWorker()).ways.checkDevice()).toBe("none");
  });

  it("forgets the key when this device was removed", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    await first.ways.setUp({ kind: "passkey" });
    const second = device(worker);
    const opened = await second.ways.openWith({ kind: "passkey" });
    await first.ways.removeWay(opened.deviceId ?? "");
    expect(await second.ways.checkDevice()).toBe("forgotten");
    expect(await deviceKey(ACCOUNT, second.shelf)).toBeNull();
    expect(await first.ways.checkDevice()).toBe("kept");
  });

  it("forgets the key when the key ref changed", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    await first.ways.setUp({ kind: "password", password: PASSWORD });
    const again = device(worker, { makeKey: () => new Uint8Array(32).fill(0x24) as Bytes });
    await (await again.ways.prepareStartAgain({ kind: "password", password: "the next long phrase" })).save();
    expect(await first.ways.checkDevice()).toBe("forgotten");
    expect(await deviceKey(ACCOUNT, first.shelf)).toBeNull();
  });

  it("changes nothing when the Worker cannot be reached", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    await first.ways.setUp({ kind: "passkey" });
    worker.setOffline(true);
    expect(await first.ways.checkDevice()).toBe("kept");
    expect(await deviceKey(ACCOUNT, first.shelf)).not.toBeNull();
  });

  it("forgets on sign-out", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    await first.ways.setUp({ kind: "passkey" });
    await first.ways.forget();
    expect(await deviceKey(ACCOUNT, first.shelf)).toBeNull();
  });
});

describe("what the Worker is sent", () => {
  it("never holds the account key, field key, PRF output, vault password or recovery key", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    const recoveries: string[] = [];

    const set = await first.ways.setUp({ kind: "passkey" });
    recoveries.push(set.recoveryKey);
    await first.ways.addWay({ kind: "password", password: PASSWORD }, { kind: "passkey" });
    const fresh = await first.ways.newRecoveryKey({ kind: "password", password: PASSWORD });
    recoveries.push(fresh.recoveryKey);
    await fresh.save();

    const second = device(worker);
    await second.ways.openWith({ kind: "passkey" });
    await device(worker).ways.openWith({ kind: "password", password: PASSWORD });
    await device(worker).ways.openWith({ kind: "recovery", recoveryKey: fresh.recoveryKey });

    const paired = device(worker);
    const handle = await paired.ways.startPairing();
    await first.ways.allowPairing({ kind: "password", password: PASSWORD }, handle.id, handle.publicPart);
    await paired.ways.finishPairing(handle);

    const again = device(worker, { makeKey: () => new Uint8Array(32).fill(0x24) as Bytes });
    const restart = await again.ways.prepareStartAgain({ kind: "password", password: PASSWORD });
    await restart.save();

    expect(worker.bodies.length).toBeGreaterThan(15);
    const all = worker.bodies.join("\n");
    const secrets = (await secretsOf(recoveries)).filter((s) => s.length >= 8);
    expect(secrets.length).toBeGreaterThan(30);
    for (const secret of secrets) expect(all).not.toContain(secret);
    // The check is not vacuous: a wrapped copy is there, and it is not the key.
    expect(all).toContain("wrapped");
  });
});

describe("proving a way in", () => {
  it("accepts a right way, refuses a wrong one, and adds no device row either time", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    await first.ways.setUp({ kind: "password", password: PASSWORD });
    const rowsBefore = worker.rows.length;
    const other = device(worker);
    await other.ways.prove({ kind: "password", password: PASSWORD });
    await expect(other.ways.prove({ kind: "password", password: "not the phrase at all" })).rejects.toBeInstanceOf(KeyWayError);
    expect(worker.rows.length).toBe(rowsBefore);
    expect(await deviceKey(ACCOUNT, other.shelf)).toBeNull();
  });

  it("says there is no key when none was set up", async () => {
    const other = device(fakeWorker());
    await expect(other.ways.prove({ kind: "password", password: PASSWORD })).rejects.toMatchObject({ problem: "none" });
  });
});

describe("rejoining after a restore", () => {
  it("lists this device again under a new id and keeps the same field key", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    const { opened } = await first.ways.setUp({ kind: "password", password: PASSWORD });
    // A restore gives every row a new id, so this device's own row is gone.
    for (const row of worker.rows) if (row.kind === "device") row.archived = true;
    const before = await first.ways.held();
    expect(before).not.toBeNull();
    const again = await first.ways.rejoin({ fieldKey: opened.fieldKey, keyRef: opened.keyRef });
    expect(again.kept).toBe(true);
    expect(again.deviceId).not.toBe(opened.deviceId);
    expect((await deviceKey(ACCOUNT, first.shelf))?.fieldKey).toBe(opened.fieldKey);
    expect(await first.ways.checkDevice()).toBe("kept");
  });

  it("refuses a key that is not the Worker's, and leaves no row when it cannot be kept", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    const { opened } = await first.ways.setUp({ kind: "password", password: PASSWORD });
    await expect(first.ways.rejoin({ fieldKey: opened.fieldKey, keyRef: "AAAAAAAAAAA" })).rejects.toBeInstanceOf(KeyWayError);
    const full = device(worker, { shelf: { get: async () => undefined, put: () => Promise.reject(new Error("full")), remove: async () => undefined } });
    const live = worker.rows.filter((r) => !r.archived && r.kind === "device").length;
    const result = await full.ways.rejoin({ fieldKey: opened.fieldKey, keyRef: opened.keyRef });
    expect(result.kept).toBe(false);
    expect(worker.rows.filter((r) => !r.archived && r.kind === "device").length).toBe(live);
  });

  it("sends no field key, plaintext or envelope when proving, rejoining and sealing", async () => {
    const worker = fakeWorker();
    const first = device(worker);
    const { opened } = await first.ways.setUp({ kind: "password", password: PASSWORD });
    const vault = createVault(ACCOUNT, { shelf: first.shelf, keysNow: worker.api.keysNow });
    const plain = "the safe code is 4821 and the gate is 1357";
    const sealed = await vault.sealField("notes", "n1", "body", plain);
    await first.ways.prove({ kind: "password", password: PASSWORD });
    await first.ways.rejoin({ fieldKey: opened.fieldKey, keyRef: opened.keyRef });
    await vault.state();
    const all = worker.bodies.join("\n");
    expect(worker.bodies.length).toBeGreaterThan(3);
    for (const secret of (await secretsOf([])).filter((s) => s.length >= 8)) expect(all).not.toContain(secret);
    expect(all).not.toContain(plain);
    expect(all).not.toContain("4821");
    // Sealing and opening a field send nothing at all; the envelope goes only where a caller saves it.
    expect(sealed).not.toBeNull();
    expect(all).not.toContain(sealed ?? "");
  });
});

describe("the label", () => {
  it("names the browser and the system", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
    expect(deviceLabel("")).toBe("Browser");
  });
});
