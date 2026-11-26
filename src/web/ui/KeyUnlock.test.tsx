import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { KeyRow, KeyState } from "../api.js";
import type { OpenWay, Opened } from "../keyWays.js";
import { offersPasskey, PasskeyOffer, UnlockView, unlockWays, type UnlockHandlers, type UnlockStep } from "./KeyUnlock.js";

const nothing = (): void => undefined;
const on: UnlockHandlers = { ask: nothing, open: nothing, pair: nothing, confirm: nothing };

const row = (id: string, kind: KeyRow["kind"]): KeyRow => ({
  id, kind, label: kind, deviceId: null, credentialId: null, salt: null, iterations: null, wrapped: null,
  createdAt: "2026-11-19T02:00:00.000Z",
});
const state = (...kinds: KeyRow["kind"][]): KeyState => ({ keyRef: "ref", keyCheck: "check", wraps: kinds.map((k, i) => row(`r${i}`, k)) });

const draw = (keys: KeyState, opts: { prf?: boolean; step?: UnlockStep; problem?: string | null } = {}): string =>
  renderToStaticMarkup(<UnlockView keys={keys} prf={opts.prf ?? false} step={opts.step ?? "idle"} busy={false} problem={opts.problem ?? null} on={on} />);

const dash = String.fromCharCode(0x2014);

describe("KeyUnlock ways in", () => {
  it("offers Face ID or fingerprint only with a live passkey row and a device that can use it", () => {
    expect(draw(state("device", "passkey", "recovery"), { prf: true })).toContain("Face ID or fingerprint");
    expect(draw(state("device", "passkey", "recovery"), { prf: false })).not.toContain("Face ID or fingerprint");
    expect(draw(state("device", "recovery"), { prf: true })).not.toContain("Face ID or fingerprint");
  });

  it("offers the vault password only when a password row exists", () => {
    expect(draw(state("password", "recovery"))).toContain("Vault password");
    expect(draw(state("recovery"))).not.toContain("Vault password");
  });

  it("always offers the recovery key and another device", () => {
    for (const keys of [state(), state("password")]) {
      const out = draw(keys);
      expect(out).toContain("Recovery key");
      expect(out).toContain("Use another device");
    }
    expect(unlockWays(state(), false)).toEqual({ passkey: false, password: false, recovery: true });
  });

  it("asks for the vault password or the recovery key under the row that was opened", () => {
    const keys = state("password", "recovery");
    expect(draw(keys, { step: "password" })).toContain('aria-label="Vault password"');
    expect(draw(keys, { step: "password" })).not.toContain('aria-label="Recovery key"');
    expect(draw(keys, { step: "recovery" })).toContain('aria-label="Recovery key"');
  });

  it("shows a refusal in words", () => {
    expect(draw(state("password"), { step: "password", problem: "That didn't work. Try again." })).toContain("That didn&#x27;t work. Try again.");
  });
});

describe("KeyUnlock every way in lost", () => {
  it("offers the choice, and says nothing about it until it is chosen", () => {
    const out = draw(state("password"));
    expect(out).toContain("lost every way in");
    expect(out).not.toContain("Start again with a new key");
    expect(out).not.toContain("can&#x27;t be opened");
  });

  it("says plainly that locked things cannot be opened, and offers a new key", () => {
    const out = draw(state("password"), { step: "lost" });
    expect(out).toContain("Locked things can&#x27;t be opened without one of these.");
    expect(out).toContain(">Start again with a new key<");
    expect(out).not.toContain('aria-label="Sign-in password"');
  });

  it("needs the sign-in password typed before it starts again", () => {
    const out = draw(state("password"), { step: "again" });
    expect(out).toContain('aria-label="Sign-in password"');
    expect(out).toContain('type="password"');
    expect(out).toContain('autoComplete="current-password"');
  });

  it("holds no em-dash and no instruction sentence", () => {
    const out = draw(state("password", "passkey", "recovery"), { prf: true, step: "again" });
    expect(out).not.toContain(dash);
  });
});

describe("the offer after a way in without Face ID or a fingerprint", () => {
  const kept: Opened = { fieldKey: {} as CryptoKey, keyRef: "ref", deviceId: "d", kept: true };
  const password: OpenWay = { kind: "password", password: "x" };

  it("comes after a password or recovery key on a device that can, once", () => {
    expect(offersPasskey(password, kept, true, false)).toBe(true);
    expect(offersPasskey({ kind: "recovery", recoveryKey: "x" }, kept, true, false)).toBe(true);
    expect(offersPasskey(password, kept, true, true)).toBe(false);
  });

  it("does not come after a passkey, on a device that cannot, or where nothing was kept", () => {
    expect(offersPasskey({ kind: "passkey" }, kept, true, false)).toBe(false);
    expect(offersPasskey(password, kept, false, false)).toBe(false);
    expect(offersPasskey(password, { ...kept, kept: false }, true, false)).toBe(false);
  });

  it("is one button and Not now", () => {
    const out = renderToStaticMarkup(<PasskeyOffer busy={false} problem={null} onUse={nothing} onNotNow={nothing} />);
    expect(out).toContain(">Use Face ID or fingerprint here<");
    expect(out).toContain(">Not now<");
  });
});
