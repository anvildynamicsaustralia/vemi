import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { KeyRow, KeyState } from "../api.js";
import type { Opened } from "../keyWays.js";
import { addedOn, keyReady, PrivacyRows, PrivacySection, proofWays, type PrivacyHandlers, type PrivacyStep } from "./AccountPrivacy.js";

const nothing = (): void => undefined;
const on: PrivacyHandlers = { setUp: nothing, remove: nothing, ask: nothing, prove: nothing };

const row = (id: string, kind: KeyRow["kind"], extra: Partial<KeyRow> = {}): KeyRow => ({
  id, kind, label: kind, deviceId: null, credentialId: null, salt: null, iterations: null, wrapped: null,
  createdAt: "2026-11-19T02:00:00.000Z", ...extra,
});

const state = (wraps: KeyRow[]): KeyState => ({ keyRef: "ref", keyCheck: "check", wraps });

const draw = (keys: KeyState | null, opts: { here?: string | null; prf?: boolean; step?: PrivacyStep; problem?: string | null } = {}): string =>
  renderToStaticMarkup(
    <PrivacyRows keys={keys} here={opts.here ?? null} prf={opts.prf ?? false} step={opts.step ?? "idle"} busy={false}
      problem={opts.problem ?? null} on={on} />,
  );

const keyed = [
  row("d1", "device", { label: "Chrome on Windows" }),
  row("d2", "device", { label: "Safari on iPhone", createdAt: "2026-11-20T00:00:00.000Z" }),
  row("r1", "recovery"),
];

describe("AccountPrivacy rows", () => {
  it("offers Set up on one Locking row when there is no key", () => {
    const out = draw({ keyRef: null, keyCheck: null, wraps: [] });
    expect(out).toContain("Locking");
    expect(out).toContain(">Set up<");
    expect(out).not.toContain("Devices");
    expect(out).not.toContain("Recovery key");
  });

  it("holds the Locking row in place, disabled, until the Worker has answered", () => {
    const out = draw(null);
    expect(out).toContain("Locking");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Set up</);
  });

  it("lists each device with its day, marks this one and offers Remove on every row", () => {
    const out = draw(state(keyed), { here: "d1" });
    expect(out).toContain("Devices");
    expect(out).toContain("Chrome on Windows");
    expect(out).toContain("Safari on iPhone");
    expect(out).toContain("Added 2026-11-19");
    expect(out).toContain("Added 2026-11-20");
    expect(out.match(/This device/g)).toHaveLength(1);
    expect(out.match(/>Remove</g)).toHaveLength(2);
  });

  it("shows the four key rows once there is a key", () => {
    const out = draw(state(keyed), { here: "d1", prf: true });
    for (const title of ["Devices", "Face ID or fingerprint", "Vault password", "Recovery key"]) expect(out).toContain(title);
    expect(out).toContain(">Make a new one<");
  });

  it("offers Add on this device only where PRF is possible and this device has no passkey", () => {
    expect(draw(state(keyed), { here: "d1", prf: true })).toContain(">Add on this device<");
    expect(draw(state(keyed), { here: "d1", prf: false })).not.toContain("Add on this device");
    expect(draw(state(keyed), { here: null, prf: true })).not.toContain("Add on this device");
    const withPasskey = state([...keyed, row("p1", "passkey", { deviceId: "d1" })]);
    const out = draw(withPasskey, { here: "d1", prf: true });
    expect(out).not.toContain("Add on this device");
    expect(out).toContain("Set up on this device");
  });

  it("says Add for a missing vault password and Change for one that exists", () => {
    expect(draw(state(keyed))).toMatch(/Vault password[\s\S]*>Add</);
    expect(draw(state([...keyed, row("w1", "password")]))).toMatch(/Vault password[\s\S]*>Change</);
  });

  it("asks one way in under the row that needs it, only with the ways that exist", () => {
    const rows = state([...keyed, row("w1", "password"), row("p1", "passkey", { deviceId: "d2" })]);
    const out = draw(rows, { here: "d1", prf: true, step: "recovery" });
    expect(out).toContain("Face ID or fingerprint</button>");
    expect(out).toContain("Use vault password");
    expect(out).toContain("Use recovery key");
    const bare = draw(state(keyed), { here: "d1", prf: true, step: "recovery" });
    expect(bare).not.toContain("Use vault password");
    expect(bare).not.toContain("Face ID or fingerprint</button>");
  });

  it("asks the new vault password twice with its row note", () => {
    const out = draw(state(keyed), { step: "password" });
    expect(out).toContain("New vault password again");
    expect(out).toContain("Not your sign-in password.");
  });

  it("shows a refusal beside the form that met it", () => {
    expect(draw(state(keyed), { step: "recovery", problem: "That didn't work. Try again." })).toContain("That didn&#x27;t work. Try again.");
  });

  it("holds no em-dash and no instruction sentence", () => {
    const out = draw(state(keyed), { here: "d1", prf: true, step: "password" });
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("proofWays and addedOn", () => {
  it("counts a passkey only where this device can use it", () => {
    const rows = state([row("p1", "passkey"), row("w1", "password"), row("r1", "recovery")]);
    expect(proofWays(rows, true)).toEqual({ passkey: true, password: true, recovery: true });
    expect(proofWays(rows, false).passkey).toBe(false);
  });

  it("takes the day from the stamp", () => {
    expect(addedOn("2026-11-19T02:00:00.000Z")).toBe("2026-11-19");
  });
});

describe("PrivacySection", () => {
  const section = (owner: boolean | null, local = false): string =>
    renderToStaticMarkup(
      <PrivacySection owner={owner} local={local} appLock={<div className="app-lock-row">App lock</div>}>
        <PrivacyRows keys={state(keyed)} here="d1" prf={false} step="idle" busy={false} problem={null} on={on} />
      </PrivacySection>,
    );

  it("says where an invitee's data is kept, without a name", () => {
    expect(section(false)).toContain("This VEMI is run by the person who invited you. Anything you don&#x27;t lock is stored on their Cloudflare space.");
  });

  it("says where the owner's data is kept", () => {
    expect(section(true)).toContain("This VEMI runs on your own Cloudflare space.");
  });

  it("says device only when the local flag is passed", () => {
    expect(section(true, true)).toContain("Kept on this device only.");
  });

  it("says nothing until it is known who is asking", () => {
    expect(section(null)).not.toContain("Cloudflare");
  });

  it("holds the devices with Remove, the recovery key, the vault password and App lock", () => {
    const out = section(true);
    expect(out).toContain(">Remove<");
    expect(out).toContain("Recovery key");
    expect(out).toContain("Vault password");
    expect(out).toContain("App lock");
  });
});

describe("keyReady", () => {
  it("tells the vault the key opened, then reloads the rows", () => {
    const calls: string[] = [];
    const opened = { deviceId: "d1" } as unknown as Opened;
    const vault = { opened: vi.fn(() => { calls.push("vault"); }) };
    keyReady(vault, opened, () => { calls.push("reload"); });
    expect(vault.opened).toHaveBeenCalledWith(opened);
    expect(calls).toEqual(["vault", "reload"]);
  });
});
