import { describe, expect, it } from "vitest";
import { noteMarkup } from "./noteMarkup.js";

describe("noteMarkup", () => {
  it("returns plain text as one text span", () => {
    expect(noteMarkup("Just a note")).toEqual([{ kind: "text", text: "Just a note" }]);
  });

  it("returns nothing for an empty note", () => {
    expect(noteMarkup("")).toEqual([]);
  });

  it("marks bold between double stars", () => {
    expect(noteMarkup("Email dropped. **Push only**, free.")).toEqual([
      { kind: "text", text: "Email dropped. " },
      { kind: "bold", text: "Push only" },
      { kind: "text", text: ", free." },
    ]);
  });

  it("marks code between backticks", () => {
    expect(noteMarkup("Stays on `anvil-core` for now")).toEqual([
      { kind: "text", text: "Stays on " },
      { kind: "code", text: "anvil-core" },
      { kind: "text", text: " for now" },
    ]);
  });

  it("leaves an unclosed marker as text", () => {
    expect(noteMarkup("a **b")).toEqual([{ kind: "text", text: "a **b" }]);
    expect(noteMarkup("a `b")).toEqual([{ kind: "text", text: "a `b" }]);
  });

  it("leaves an empty pair as text", () => {
    expect(noteMarkup("a **** b")).toEqual([{ kind: "text", text: "a **** b" }]);
    expect(noteMarkup("a `` b")).toEqual([{ kind: "text", text: "a `` b" }]);
  });

  it("does not read bold inside code", () => {
    expect(noteMarkup("`**x**`")).toEqual([{ kind: "code", text: "**x**" }]);
  });

  it("keeps line breaks in the text", () => {
    expect(noteMarkup("one\n**two**")).toEqual([
      { kind: "text", text: "one\n" },
      { kind: "bold", text: "two" },
    ]);
  });

  it("returns markup that is not bold or code as plain text spans", () => {
    for (const raw of ["<script>alert(1)</script>", "<b>x</b>", "[x](javascript:y)"]) {
      expect(noteMarkup(raw)).toEqual([{ kind: "text", text: raw }]);
    }
  });
});
