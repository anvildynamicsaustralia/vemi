import { beforeEach, describe, expect, it } from "vitest";
import { askForAbout, askForLedger, onLedgerAsk, takeLedgerAsk } from "./ledgerReach.js";

describe("ledgerReach", () => {
  beforeEach(() => {
    takeLedgerAsk("a");
    takeLedgerAsk("b");
  });

  it("answers once for the id asked", () => {
    askForLedger("a");
    expect(takeLedgerAsk("a")).toBe("ledger");
    expect(takeLedgerAsk("a")).toBeNull();
  });

  it("answers nothing for an id nobody asked for, and keeps the ask for its own page", () => {
    askForLedger("a");
    expect(takeLedgerAsk("b")).toBeNull();
    expect(takeLedgerAsk("a")).toBe("ledger");
  });

  it("remembers only the latest ask", () => {
    askForLedger("a");
    askForLedger("b");
    expect(takeLedgerAsk("a")).toBeNull();
    expect(takeLedgerAsk("b")).toBe("ledger");
  });

  it("says when About was asked for rather than the ledger, and the latest ask wins", () => {
    askForAbout("a");
    expect(takeLedgerAsk("a")).toBe("about");
    askForLedger("a");
    askForAbout("a");
    expect(takeLedgerAsk("a")).toBe("about");
    expect(takeLedgerAsk("a")).toBeNull();
  });

  it("tells a page that is already open, so it can take the ask itself", () => {
    const taken: (string | null)[] = [];
    const stop = onLedgerAsk(() => taken.push(takeLedgerAsk("a")));
    askForLedger("a");
    askForAbout("a");
    expect(taken).toEqual(["ledger", "about"]);
    expect(takeLedgerAsk("a")).toBeNull();
    stop();
    askForLedger("a");
    expect(taken).toEqual(["ledger", "about"]);
    takeLedgerAsk("a");
  });
});
