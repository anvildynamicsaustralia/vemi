import { describe, expect, it } from "vitest";
import { isShareAddress, shareParams, withoutShared } from "./shareParams.js";

describe("shareParams", () => {
  it("uses the shared title, and puts the url then the text in the body", () => {
    const got = shareParams("?title=Good%20read&text=worth%20a%20look&url=https%3A%2F%2Fa.example%2Fp");
    expect(got).toEqual({ title: "Good read", body: "https://a.example/p\n\nworth a look" });
  });

  it("takes the first line of the text when there is no title, and keeps the rest", () => {
    const got = shareParams("?text=Buy%20oats%0Afrom%20the%20market&url=https%3A%2F%2Fa.example");
    expect(got).toEqual({ title: "Buy oats", body: "https://a.example\n\nfrom the market" });
  });

  it("makes the url the title when it is all there is", () => {
    expect(shareParams("?url=https%3A%2F%2Fa.example")).toEqual({ title: "https://a.example", body: "" });
  });

  it("is null when nothing was shared", () => {
    expect(shareParams("")).toBeNull();
    expect(shareParams("?title=%20&text=&url=")).toBeNull();
    expect(shareParams("?task=abc")).toBeNull();
  });

  it("keeps a title within the task limit", () => {
    const got = shareParams(`?title=${"a".repeat(500)}`);
    expect(got?.title.length).toBe(300);
  });
});

describe("withoutShared", () => {
  it("drops the three share params and keeps the rest", () => {
    expect(withoutShared("?title=a&text=b&url=c&task=1")).toBe("?task=1");
    expect(withoutShared("?title=a")).toBe("");
  });
});

describe("isShareAddress", () => {
  it("is the Add path only", () => {
    expect(isShareAddress("/add")).toBe(true);
    expect(isShareAddress("/today")).toBe(false);
  });
});
