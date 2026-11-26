import { describe, expect, it } from "vitest";
import { pairLink, parsePairLink } from "./pairLink.js";

const request = { id: "AbC_123-xyz", publicPart: "BPublic_key-part0123456789" };

describe("pairLink", () => {
  it("round trips through the whole link", () => {
    const link = pairLink("https://vemi.example.workers.dev", request);
    expect(link).toBe("https://vemi.example.workers.dev/account#pair=AbC_123-xyz.BPublic_key-part0123456789");
    expect(parsePairLink(link)).toEqual(request);
  });

  it("reads a bare fragment", () => {
    expect(parsePairLink("#pair=AbC_123-xyz.BPublic_key-part0123456789")).toEqual(request);
  });

  it("keeps both parts after the hash, so the Worker is never sent them", () => {
    const link = pairLink("http://localhost:8787", request);
    const [beforeHash] = link.split("#");
    expect(beforeHash).not.toContain(request.publicPart);
    expect(beforeHash).not.toContain(request.id);
  });

  it("refuses anything that is not a pairing", () => {
    for (const text of ["", "#", "#google=abc", "#pair=", "#pair=onlyid", "#pair=a.b.c", "#pair=a b.c", "#pair=a.", "#pair=.b",
      `#pair=${"a".repeat(201)}.b`]) {
      expect(parsePairLink(text)).toBeNull();
    }
  });
});
