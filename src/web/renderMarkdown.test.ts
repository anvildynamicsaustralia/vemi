import { describe, expect, it } from "vitest";
import { renderMarkdown, type Block } from "./renderMarkdown.js";

const text = (t: string) => ({ kind: "text", text: t });
const link = (t: string, href: string) => ({ kind: "link", text: t, href });

describe("renderMarkdown", () => {
  it("gives nothing back for nothing written", () => {
    expect(renderMarkdown(null)).toEqual([]);
    expect(renderMarkdown("")).toEqual([]);
  });

  it("gives nothing back for a body of only blank lines", () => {
    expect(renderMarkdown("\n  \n\t\n\n")).toEqual([]);
  });

  it("reads a heading", () => {
    expect(renderMarkdown("## The brief")).toEqual([{ kind: "heading", spans: [text("The brief")] }]);
  });

  it("wants the space after the hashes, and takes one to three of them as the one heading", () => {
    expect(renderMarkdown("##The brief")).toEqual([{ kind: "paragraph", spans: [text("##The brief")] }]);
    expect(renderMarkdown("# The brief")).toEqual([{ kind: "heading", spans: [text("The brief")] }]);
    expect(renderMarkdown("### The brief")).toEqual([{ kind: "heading", spans: [text("The brief")] }]);
    expect(renderMarkdown("#### The brief")).toEqual([{ kind: "paragraph", spans: [text("#### The brief")] }]);
  });

  it("reads a run of dashes as one list", () => {
    expect(renderMarkdown("- one\n- two\n- three")).toEqual([
      { kind: "list", items: [[text("one")], [text("two")], [text("three")]] },
    ]);
  });

  it("breaks a list in two at a blank line", () => {
    expect(renderMarkdown("- one\n- two\n\n- three")).toEqual([
      { kind: "list", items: [[text("one")], [text("two")]] },
      { kind: "list", items: [[text("three")]] },
    ]);
  });

  it("reads a paragraph, and keeps the line someone broke on purpose", () => {
    expect(renderMarkdown("Call the accountant.\nBefore Friday.")).toEqual([
      { kind: "paragraph", spans: [text("Call the accountant.\nBefore Friday.")] },
    ]);
  });

  it("separates paragraphs at a blank line, and lets a heading and a list end one", () => {
    expect(renderMarkdown("First.\n\nSecond.")).toEqual([
      { kind: "paragraph", spans: [text("First.")] },
      { kind: "paragraph", spans: [text("Second.")] },
    ]);
    expect(renderMarkdown("Lead in.\n## Then\n- and\nAfter.")).toEqual([
      { kind: "paragraph", spans: [text("Lead in.")] },
      { kind: "heading", spans: [text("Then")] },
      { kind: "list", items: [[text("and")]] },
      { kind: "paragraph", spans: [text("After.")] },
    ]);
  });

  it("reads a link, in a paragraph, a heading and a list item alike", () => {
    expect(renderMarkdown("See [the form](https://example.com/f) first.")).toEqual([
      { kind: "paragraph", spans: [text("See "), link("the form", "https://example.com/f"), text(" first.")] },
    ]);
    expect(renderMarkdown("## [Notes](https://example.com)")).toEqual([
      { kind: "heading", spans: [link("Notes", "https://example.com")] },
    ]);
    expect(renderMarkdown("- [Andy](mailto:andy@example.com)")).toEqual([
      { kind: "list", items: [[link("Andy", "mailto:andy@example.com")]] },
    ]);
  });

  it("reads two links in one line", () => {
    expect(renderMarkdown("[one](http://a.example) and [two](https://b.example)")).toEqual([
      {
        kind: "paragraph",
        spans: [link("one", "http://a.example"), text(" and "), link("two", "https://b.example")],
      },
    ]);
  });

  it("keeps a pair of parentheses inside a url", () => {
    expect(renderMarkdown("[wiki](https://example.com/Thing_(disambiguation)) here")).toEqual([
      {
        kind: "paragraph",
        spans: [link("wiki", "https://example.com/Thing_(disambiguation)"), text(" here")],
      },
    ]);
  });

  it("refuses every scheme but http, https and mailto, and leaves the words as typed", () => {
    for (const href of ["javascript:alert(1)", "data:text/html;base64,PHM+", "vbscript:x", "file:///etc/passwd"]) {
      const written = `[click me](${href})`;
      expect(renderMarkdown(written), href).toEqual([{ kind: "paragraph", spans: [text(written)] }]);
    }
  });

  it("refuses a link with no scheme at all", () => {
    expect(renderMarkdown("[here](/tasks)")).toEqual([{ kind: "paragraph", spans: [text("[here](/tasks)")] }]);
    expect(renderMarkdown("[here](example.com)")).toEqual([{ kind: "paragraph", spans: [text("[here](example.com)")] }]);
  });

  it("does not let a case change or padding past the scheme check", () => {
    expect(renderMarkdown("[x](JavaScript:alert(1))")).toEqual([
      { kind: "paragraph", spans: [text("[x](JavaScript:alert(1))")] },
    ]);
    expect(renderMarkdown("[x](  javascript:alert(1)  )")).toEqual([
      { kind: "paragraph", spans: [text("[x](  javascript:alert(1)  )")] },
    ]);
    expect(renderMarkdown("[x](HTTPS://example.com)")).toEqual([
      { kind: "paragraph", spans: [link("x", "HTTPS://example.com")] },
    ]);
  });

  it("leaves an unclosed bracket exactly where it was typed", () => {
    expect(renderMarkdown("A [thing that never shuts")).toEqual([
      { kind: "paragraph", spans: [text("A [thing that never shuts")] },
    ]);
    expect(renderMarkdown("[text] (https://example.com)")).toEqual([
      { kind: "paragraph", spans: [text("[text] (https://example.com)")] },
    ]);
    expect(renderMarkdown("[text](https://example.com")).toEqual([
      { kind: "paragraph", spans: [text("[text](https://example.com")] },
    ]);
  });

  it("does not let a link reach across a newline in one paragraph", () => {
    expect(renderMarkdown("Read [the form](https://ok\n.com) today.")).toEqual([
      { kind: "paragraph", spans: [text("Read [the form](https://ok\n.com) today.")] },
    ]);
    expect(renderMarkdown("A [word\n](https://example.com)")).toEqual([
      { kind: "paragraph", spans: [text("A [word\n](https://example.com)")] },
    ]);
  });

  it("reads a link on each line of one paragraph, with the newline between them", () => {
    expect(renderMarkdown("[one](https://a.example)\n[two](https://b.example)")).toEqual([
      {
        kind: "paragraph",
        spans: [link("one", "https://a.example"), text("\n"), link("two", "https://b.example")],
      },
    ]);
  });

  it("leaves text that only looks like syntax as text", () => {
    expect(renderMarkdown("5 - 3 is 2")).toEqual([{ kind: "paragraph", spans: [text("5 - 3 is 2")] }]);
    expect(renderMarkdown("#hashtag")).toEqual([{ kind: "paragraph", spans: [text("#hashtag")] }]);
    expect(renderMarkdown("*not bold* and `not code` and > not a quote")).toEqual([
      { kind: "paragraph", spans: [text("*not bold* and `not code` and > not a quote")] },
    ]);
    expect(renderMarkdown("1. not an ordered list")).toEqual([
      { kind: "paragraph", spans: [text("1. not an ordered list")] },
    ]);
  });

  it("reads a whole body the sheet would hold", () => {
    const blocks: readonly Block[] = renderMarkdown(
      "## What this is\n\nFile the return before the deadline.\n\n- gather receipts\n- ask [the accountant](mailto:acc@example.com)\n",
    );
    expect(blocks).toEqual([
      { kind: "heading", spans: [text("What this is")] },
      { kind: "paragraph", spans: [text("File the return before the deadline.")] },
      {
        kind: "list",
        items: [[text("gather receipts")], [text("ask "), link("the accountant", "mailto:acc@example.com")]],
      },
    ]);
  });

  it("never links into the app", () => {
    for (const written of ["[a](/docs/x)", "[a](//evil.example)", "[a](/docs/../api)", "[a](/tasks)"]) {
      expect(renderMarkdown(written), written).toEqual([{ kind: "paragraph", spans: [text(written)] }]);
    }
  });
});
