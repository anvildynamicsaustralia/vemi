import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { worthSendingAgain } from "./sendAgain.js";

describe("worthSendingAgain", () => {
  it("does not offer to send a refusal again: the answer would be the same", () => {
    expect(worthSendingAgain(new ApiError(400, "each item in tagIds must be an id"))).toBe(false);
    expect(worthSendingAgain(new ApiError(404, "no such tag"))).toBe(false);
    expect(worthSendingAgain(new ApiError(409, "there is already a tag called that"))).toBe(false);
    expect(worthSendingAgain(new ApiError(401, "sign in first"))).toBe(false);
  });

  it("offers again when the Worker never answered", () => {
    expect(worthSendingAgain(new ApiError(500, "internal error"))).toBe(true);
    expect(worthSendingAgain(new ApiError(503, "no"))).toBe(true);
    // A connection that broke mid-flight: fetch rejects, and nothing read the write.
    expect(worthSendingAgain(new TypeError("Failed to fetch"))).toBe(true);
    expect(worthSendingAgain(new ApiError(0, "Couldn't reach VEMI."))).toBe(true);
    expect(worthSendingAgain("something thrown that is not an error")).toBe(true);
  });
});
