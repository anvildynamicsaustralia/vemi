import { describe, expect, it, vi } from "vitest";
import { sealedEpoch } from "../sealedApi.js";
import { keyMoved } from "./Vault.js";

describe("keyMoved", () => {
  it("brings the shown screens up again when a key opens, so a locked page is not left locked", () => {
    const refetch = vi.fn();
    const before = sealedEpoch();
    keyMoved("open", refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(sealedEpoch()).toBe(before + 1);
  });

  it("only redraws, with no fetch, when the key is not open", () => {
    for (const state of ["unknown", "none", "closed"] as const) {
      const refetch = vi.fn();
      keyMoved(state, refetch);
      expect(refetch).not.toHaveBeenCalled();
    }
  });
});
