import { describe, expect, it } from "vitest";
import { inviteGreeting, peopleRows, until } from "./peopleRows.js";

const NOW = new Date("2026-11-19T10:00:00Z");

describe("until", () => {
  it("says the fewest words that stay true", () => {
    expect(until("2026-11-19T10:20:00Z", NOW)).toBe("in 20 min");
    expect(until("2026-11-19T15:00:00Z", NOW)).toBe("in 5 h");
    expect(until("2026-11-26T10:00:00Z", NOW)).toBe("in 7 days");
    expect(until("2026-11-19T09:00:00Z", NOW)).toBe("in 1 min");
  });
});

describe("peopleRows", () => {
  const people = {
    people: [
      { id: "a", firstName: "Sam", email: "sam@example.com", deleteOn: null },
      { id: "b", firstName: null, email: "old@example.com", deleteOn: "2026-11-26T10:00:00Z" },
    ],
    invites: [{ id: "i1", firstName: "Jo", expiresAt: "2026-11-24T10:00:00Z" }],
  };

  it("lists people first, then waiting invites", () => {
    const rows = peopleRows(people, NOW);
    expect(rows.map((r) => r.key)).toEqual(["person:a", "person:b", "invite:i1"]);
  });

  it("gives a person Reset link and Remove, and names their email", () => {
    const [sam] = peopleRows(people, NOW);
    expect(sam?.title).toBe("Sam");
    expect(sam?.note).toBe("sam@example.com");
    expect(sam?.actions).toEqual(["reset", "remove"]);
  });

  it("shows a person already going by the date, with no Remove", () => {
    const row = peopleRows(people, NOW)[1];
    expect(row?.title).toBe("old@example.com");
    expect(row?.note).toContain("goes in 7 days");
    expect(row?.actions).toEqual(["reset"]);
  });

  it("gives a waiting invite only Withdraw", () => {
    const row = peopleRows(people, NOW)[2];
    expect(row?.title).toBe("Jo");
    expect(row?.note).toBe("link expires in 5 days");
    expect(row?.actions).toEqual(["withdraw"]);
  });

  it("is empty when nobody is invited", () => {
    expect(peopleRows({ people: [], invites: [] }, NOW)).toEqual([]);
  });
});

describe("inviteGreeting", () => {
  it("greets by first name and nothing else", () => {
    expect(inviteGreeting("Sam")).toBe("Hi Sam, set a password");
  });
  it("greets without a name when none is known", () => {
    expect(inviteGreeting(null)).toBe("Set a password");
  });
  it("says Google when keys are set", () => {
    expect(inviteGreeting("Sam", true)).toBe("Hi Sam, set a password or use Google");
  });
});
