import { describe, expect, it } from "vitest";
import { asksForSignIn, readReturning } from "./returning.js";

describe("someone who has signed in here before", () => {
  it("is known by a kept email and nothing else", () => {
    expect(readReturning(null)).toEqual({ been: false, email: "" });
    expect(readReturning('{"email":"sam@example.com"}')).toEqual({ been: true, email: "sam@example.com" });
    expect(readReturning('{"email":5}')).toEqual({ been: true, email: "" });
    expect(readReturning("nope")).toEqual({ been: false, email: "" });
  });
  it("is sent to the card by the home page's ?signin", () => {
    expect(asksForSignIn("?signin")).toBe(true);
    expect(asksForSignIn("?x=1&signin=")).toBe(true);
    expect(asksForSignIn("")).toBe(false);
  });
});
