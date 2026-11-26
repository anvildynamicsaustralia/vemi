import { describe, expect, it } from "vitest";
import { tagIndex } from "./tagIndex.js";

const tag = (id: string, name: string) => ({ id, name });
const legal = tag("t1", "legal");
const admin = tag("t2", "admin");
const deep = tag("t3", "deep work");
const all = [legal, admin, deep];
const names = (tags: readonly { readonly name: string }[]) => tags.map((t) => t.name);

describe("tagIndex", () => {
  it("has nothing to show when no tag exists yet", () => {
    expect(tagIndex([], [], "")).toEqual({ chosen: [], unchosen: [], matches: [], exact: null });
    expect(tagIndex([], [], "legal").exact).toBeNull();
  });

  it("puts every tag in the unchosen list for a record carrying none", () => {
    const i = tagIndex(all, [], "");
    expect(names(i.chosen)).toEqual([]);
    expect(names(i.unchosen)).toEqual(["admin", "deep work", "legal"]);
    expect(names(i.matches)).toEqual(["admin", "deep work", "legal"]);
  });

  it("parts the chosen from the unchosen, each in name order", () => {
    const i = tagIndex(all, [legal.id, deep.id], "");
    expect(names(i.chosen)).toEqual(["deep work", "legal"]);
    expect(names(i.unchosen)).toEqual(["admin"]);
  });

  it("orders by name and never by the order the ids were given in", () => {
    const i = tagIndex(all, [legal.id, admin.id, deep.id], "");
    expect(names(i.chosen)).toEqual(["admin", "deep work", "legal"]);
  });

  it("passes over an id that names no tag it was shown", () => {
    const i = tagIndex(all, [legal.id, "a tag that was archived"], "");
    expect(names(i.chosen)).toEqual(["legal"]);
    expect(names(i.unchosen)).toEqual(["admin", "deep work"]);
  });

  it("filters the unchosen by what has been typed, from the start of a name", () => {
    expect(names(tagIndex(all, [], "de").matches)).toEqual(["deep work"]);
    expect(names(tagIndex(all, [], "ad").matches)).toEqual(["admin"]);
  });

  it("filters by a word inside a name too, not only its start", () => {
    expect(names(tagIndex(all, [], "work").matches)).toEqual(["deep work"]);
    expect(names(tagIndex(all, [], "ga").matches)).toEqual(["legal"]);
  });

  it("matches without case, and past the padding either side", () => {
    expect(names(tagIndex(all, [], "  LEGAL ").matches)).toEqual(["legal"]);
  });

  it("offers nothing when the typed word matches no tag", () => {
    const i = tagIndex(all, [], "invoicing");
    expect(i.matches).toEqual([]);
    expect(i.exact).toBeNull();
  });

  it("leaves a chosen tag out of the matches, since it is already shown above them", () => {
    expect(names(tagIndex(all, [deep.id], "work").matches)).toEqual([]);
  });

  it("finds the exact name whatever the case and padding, so no second one is offered", () => {
    expect(tagIndex(all, [], "admin").exact).toEqual(admin);
    expect(tagIndex(all, [], "Admin").exact).toEqual(admin);
    expect(tagIndex(all, [], "admin  ").exact).toEqual(admin);
    expect(tagIndex(all, [], "  ADMIN  ").exact).toEqual(admin);
  });

  it("finds the exact name of a tag this record already carries", () => {
    const i = tagIndex(all, [admin.id], "Admin");
    expect(i.exact).toEqual(admin);
    expect(i.matches).toEqual([]);
  });

  it("is not an exact match on a name the typed word only begins", () => {
    expect(tagIndex(all, [], "deep").exact).toBeNull();
    expect(names(tagIndex(all, [], "deep").matches)).toEqual(["deep work"]);
  });

  it("has no exact match while nothing has been typed", () => {
    expect(tagIndex(all, [], "").exact).toBeNull();
    expect(tagIndex(all, [], "   ").exact).toBeNull();
  });
});
