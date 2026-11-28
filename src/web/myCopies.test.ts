import { describe, expect, it } from "vitest";
import { addressFrom, addressProblem, COPIES_MAX, forgetCopy, mineFrom, openLinkOf, readCopies, rememberCopy, shownAddress } from "./myCopies.js";

describe("a typed address", () => {
  it("takes what people type and gives the origin", () => {
    expect(addressFrom("vemi-app.example.com.au")).toBe("https://vemi-app.example.com.au");
    expect(addressFrom("  https://Name.sub.workers.dev/today?x=1 ")).toBe("https://name.sub.workers.dev");
    expect(addressFrom("name.workers.dev.")).toBe("https://name.workers.dev");
    expect(addressFrom("http://localhost:8799")).toBe("http://localhost:8799");
  });
  it("refuses what cannot be a copy", () => {
    for (const bad of ["", "vemi", "http://name.workers.dev", "ftp://a.b", "https://user:pw@a.b", "a b", "javascript:alert(1)"]) {
      expect(addressFrom(bad), bad).toBeNull();
    }
    expect(addressProblem("")).toContain("Type");
    expect(addressProblem("vemi")).toContain("workers.dev");
    expect(addressProblem("a.workers.dev")).toBeNull();
  });
  it("is read without https, and opened at its sign-in", () => {
    expect(shownAddress("https://a.workers.dev")).toBe("a.workers.dev");
    expect(openLinkOf("https://a.workers.dev")).toBe("https://a.workers.dev/?signin");
  });
});

describe("the kept list", () => {
  it("puts the last opened first, once, and keeps at most a few", () => {
    let list = rememberCopy([], "https://a.dev", 1);
    list = rememberCopy(list, "https://b.dev", 2);
    list = rememberCopy(list, "https://a.dev", 3);
    expect(list.map((c) => c.address)).toEqual(["https://a.dev", "https://b.dev"]);
    for (let i = 0; i < 10; i++) list = rememberCopy(list, `https://c${i}.dev`, 10 + i);
    expect(list).toHaveLength(COPIES_MAX);
    expect(forgetCopy(list, "https://c9.dev").map((c) => c.address)).not.toContain("https://c9.dev");
  });
  it("is read leniently and never throws", () => {
    expect(readCopies(null)).toEqual([]);
    expect(readCopies("not json")).toEqual([]);
    expect(readCopies('{"a":1}')).toEqual([]);
    expect(readCopies('[{"address":"https://a.dev","last":1},{"address":"bad","last":2},{"address":"https://b.dev","last":5},7]'))
      .toEqual([{ address: "https://b.dev", last: 5 }, { address: "https://a.dev", last: 1 }]);
  });
  it("takes a copy's own ?mine= only when it is a sound address", () => {
    expect(mineFrom("?mine=https%3A%2F%2Fvemi-app.example.com")).toBe("https://vemi-app.example.com");
    expect(mineFrom("?mine=javascript:alert(1)")).toBeNull();
    expect(mineFrom("")).toBeNull();
  });
});
