import { describe, expect, it } from "vitest";
import type { Me } from "./auth.js";
import { accountFrom, heedsSignOut, mustForget, oncePer, startFrom } from "./session.js";

const signedIn = (email?: string): Me => ({ signedIn: true, googleReady: true, ...(email === undefined ? {} : { email }) });
const signedOut: Me = { signedIn: false, googleReady: true };

describe("who an offline start opens as", () => {
  it("is the stored account, and nobody when nothing is stored", () => {
    expect(accountFrom("a@b.example")).toBe("a@b.example");
    expect(accountFrom(null)).toBeNull();
  });

  it("is nobody for the \"1\" kept before the account was", () => {
    expect(accountFrom("1")).toBeNull();
  });
});

describe("what this device kept, on the way in", () => {
  it("stays for the account it was kept for", () => {
    expect(mustForget("a@b.example", "a@b.example", false)).toBe(false);
  });

  it("goes for another account, or for one the Worker did not name", () => {
    expect(mustForget("c@d.example", "a@b.example", false)).toBe(true);
    expect(mustForget("a@b.example", null, false)).toBe(true);
    expect(mustForget(null, null, false)).toBe(true);
  });

  it("goes when a token page signed someone in over this tab, even the same address", () => {
    expect(mustForget("a@b.example", "a@b.example", true)).toBe(true);
  });
});

describe("how a start settles", () => {
  it("enters as the account the Worker names", () => {
    expect(startFrom(true, signedIn("a@b.example"), "c@d.example")).toEqual({ kind: "enter", account: "a@b.example" });
    expect(startFrom(true, signedIn(), null)).toEqual({ kind: "enter", account: null });
  });

  it("is out when the Worker says so, whoever this device last held", () => {
    expect(startFrom(true, signedOut, "a@b.example")).toEqual({ kind: "out", unheard: false });
  });

  it("opens as the remembered account with no answer, and out when there is none", () => {
    expect(startFrom(true, null, "a@b.example")).toEqual({ kind: "kept", account: "a@b.example" });
    expect(startFrom(true, null, null)).toEqual({ kind: "out", unheard: false });
  });

  it("stays out while a sign-out is unheard, whatever the cookie or the memory says", () => {
    expect(startFrom(false, signedIn("a@b.example"), "a@b.example")).toEqual({ kind: "out", unheard: true });
    expect(startFrom(false, null, "a@b.example")).toEqual({ kind: "out", unheard: true });
  });
});

describe("a 401 from the Worker", () => {
  it("signs out only a device that is in", () => {
    expect(heedsSignOut("in")).toBe(true);
    expect(heedsSignOut("out")).toBe(false);
    expect(heedsSignOut("checking")).toBe(false);
  });
});

describe("the session check while the socket is down", () => {
  it("asks at once, then not again until the interval has passed", () => {
    const ask = oncePer(60_000);
    expect(ask(1_000)).toBe(true);
    expect(ask(30_000)).toBe(false);
    expect(ask(60_999)).toBe(false);
    expect(ask(61_000)).toBe(true);
    expect(ask(62_000)).toBe(false);
  });
});

describe("the copy kept in the page", () => {
  it("enters as the one local account, so the key ways have a name to bind to", async () => {
    const { LOCAL_KEY_NAME } = await import("./local/mode.js");
    expect(startFrom(true, signedIn(LOCAL_KEY_NAME), null)).toEqual({ kind: "enter", account: LOCAL_KEY_NAME });
  });
});
