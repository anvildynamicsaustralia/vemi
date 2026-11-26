import { describe, expect, it } from "vitest";
import { ApiError, KEY_OFFLINE, reach } from "./api.js";

describe("reach", () => {
  it("passes an answer through", async () => {
    const response = new Response("{}");
    expect(await reach(Promise.resolve(response))).toBe(response);
  });

  it("turns a request that never got an answer into words, not 'Failed to fetch'", async () => {
    const error = await reach(Promise.reject(new TypeError("Failed to fetch"))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(KEY_OFFLINE);
    expect((error as ApiError).status).toBe(0);
  });
});
