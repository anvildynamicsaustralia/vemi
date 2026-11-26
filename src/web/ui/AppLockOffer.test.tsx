import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { memoryLockStore, readAppLock, writeAppLock } from "../appLock.js";
import type { FirstRun } from "../firstRunState.js";
import type { PendingKey } from "../keyWays.js";
import type { VaultState } from "../vault.js";
import { AppLockOffer, appLockOfferDue } from "./AppLockOffer.js";

const ACCOUNT = "a@x.test";
const ended: FirstRun = { step: null, tipsSeen: [], known: true };
const pending: PendingKey = { recoveryKey: "K", save: () => Promise.reject(new Error("not here")) };
const noop = (): void => undefined;

const draw = (over: {
  firstRun?: FirstRun;
  state?: VaultState;
  prf?: boolean;
  store?: ReturnType<typeof memoryLockStore>;
} = {}): string =>
  renderToStaticMarkup(
    <AppLockOffer account={ACCOUNT} firstRun={over.firstRun ?? ended} state={over.state ?? "none"} prf={over.prf ?? true}
      store={over.store ?? memoryLockStore()} prepare={() => Promise.resolve(pending)} onKeySaved={noop} onSeen={noop} />,
  );

describe("AppLockOffer", () => {
  it("shows the card once first run has ended, where Face ID is possible and there is no key", () => {
    const out = draw();
    expect(out).toContain("Lock VEMI with Face ID?");
    expect(out).toContain(">Lock<");
    expect(out).toContain(">Not now<");
  });

  it("is not there where Face ID or a fingerprint is not possible", () => {
    expect(draw({ prf: false })).toBe("");
  });

  it("is not there when the account already has a key", () => {
    expect(draw({ state: "closed" })).toBe("");
    expect(draw({ state: "open" })).toBe("");
  });

  it("is not there until the key state is known", () => {
    expect(draw({ state: "unknown" })).toBe("");
  });

  it("is not there once it has been seen", () => {
    expect(draw({ firstRun: { ...ended, tipsSeen: ["applock"] } })).toBe("");
  });

  it("is not there during a numbered step, or before first run is known", () => {
    expect(draw({ firstRun: { ...ended, step: 6 } })).toBe("");
    expect(draw({ firstRun: { step: null, tipsSeen: [], known: false } })).toBe("");
    expect(draw({ firstRun: { step: null, tipsSeen: null, known: true } })).toBe("");
  });

  it("is not there when App lock is already on", () => {
    const store = memoryLockStore();
    writeAppLock(ACCOUNT, "1m", 1, store);
    expect(readAppLock(ACCOUNT, store)).toBe("1m");
    expect(draw({ store })).toBe("");
  });

  it("holds no em-dash", () => {
    expect(draw()).not.toContain("\u2014");
  });
});

describe("appLockOfferDue", () => {
  it("is the same decision the card draws from", () => {
    expect(appLockOfferDue({ firstRun: ended, state: "none", prf: true, choice: "off" })).toBe(true);
    expect(appLockOfferDue({ firstRun: ended, state: "none", prf: true, choice: "5m" })).toBe(false);
  });
});
