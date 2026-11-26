import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { KeyState } from "../api.js";
import { memoryLockStore, writeAppLock, markSeen } from "../appLock.js";
import type { PendingKey } from "../keyWays.js";
import { AppLock, AppLockRow, LockCover } from "./AppLock.js";

const ACCOUNT = "a@x.test";
const keys: KeyState = {
  keyRef: "ref",
  keyCheck: "check",
  wraps: [
    { id: "1", kind: "passkey", label: "Phone" },
    { id: "2", kind: "password", label: "Vault password" },
    { id: "3", kind: "recovery", label: "Recovery key" },
  ] as unknown as KeyState["wraps"],
};
const noop = (): void => undefined;
const pending: PendingKey = { recoveryKey: "K", save: () => Promise.reject(new Error("not here")) };

describe("LockCover", () => {
  it("asks Face ID or a fingerprint, or the vault password, not the recovery key", () => {
    const out = renderToStaticMarkup(<LockCover keys={keys} prf busy={false} problem={null} onProve={noop} onTryAgain={noop} />);
    expect(out).toContain("Face ID or fingerprint");
    expect(out).toContain('aria-label="Vault password to open the key"');
    expect(out).not.toContain("Recovery key to open");
  });
  it("falls back to the recovery key only when nothing else can open it", () => {
    const only = { ...keys, wraps: keys.wraps.filter((w) => w.kind === "recovery") };
    const out = renderToStaticMarkup(<LockCover keys={only} prf busy={false} problem={null} onProve={noop} onTryAgain={noop} />);
    expect(out).toContain("Recovery key to open");
  });
  it("says it could not reach VEMI and offers another try", () => {
    const out = renderToStaticMarkup(<LockCover keys={null} prf busy={false} problem="Couldn't reach VEMI." onProve={noop} onTryAgain={noop} />);
    expect(out).toContain("Couldn&#x27;t reach VEMI.");
    expect(out).toContain(">Try again<");
  });
});

describe("AppLock", () => {
  const draw = (store: ReturnType<typeof memoryLockStore>, at: number, account: string | null = ACCOUNT): string =>
    renderToStaticMarkup(
      <AppLock account={account} prf now={() => at} store={store} loadKeys={() => Promise.resolve(keys)} prove={() => Promise.resolve()}>
        <p>the page</p>
      </AppLock>,
    );

  it("draws no cover when off", () => {
    const out = draw(memoryLockStore(), 1_000_000);
    expect(out).toContain("the page");
    expect(out).not.toContain("app-lock-cover");
  });
  it("draws no cover inside the chosen time", () => {
    const store = memoryLockStore();
    writeAppLock(ACCOUNT, "5m", 1_000_000, store);
    expect(draw(store, 1_000_000 + 60_000)).not.toContain("app-lock-cover");
  });
  it("covers a cold open past the chosen time and shuts the page behind it", () => {
    const store = memoryLockStore();
    writeAppLock(ACCOUNT, "1m", 1_000_000, store);
    markSeen(ACCOUNT, 1_000_000, store);
    const out = draw(store, 1_000_000 + 61_000);
    expect(out).toContain("app-lock-cover");
    expect(out).toContain("inert");
  });
  it("never covers when nobody is signed in", () => {
    expect(draw(memoryLockStore(), 1, null)).not.toContain("app-lock-cover");
  });
});

describe("AppLockRow", () => {
  const draw = (hasKey: boolean, choice?: "5m"): string => {
    const store = memoryLockStore();
    if (choice !== undefined) writeAppLock(ACCOUNT, choice, 1, store);
    return renderToStaticMarkup(
      <AppLockRow account={ACCOUNT} hasKey={hasKey} prf prepare={() => Promise.resolve(pending)} onKeySaved={noop} store={store} />,
    );
  };
  it("offers the four choices", () => {
    const out = draw(true);
    for (const label of ["Off", "1 minute", "5 minutes", "1 hour"]) expect(out).toContain(`>${label}<`);
    expect(out).toContain("App lock");
  });
  it("marks the chosen one", () => {
    expect(draw(true, "5m")).toMatch(/aria-pressed="true"[^>]*>5 minutes</);
  });
  it("holds no em-dash", () => {
    expect(draw(false)).not.toContain(String.fromCharCode(0x2014));
  });
});
