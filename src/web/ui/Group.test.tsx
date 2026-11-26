import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Group, Kv, StatusWord } from "./Group.js";

const css = readFileSync(new URL("./detail.css", import.meta.url), "utf8");

describe("Group", () => {
  it("is a card headed by an h3 that names it, with its actions in the same row", () => {
    const out = renderToStaticMarkup(<Group title="Status" actions={<button type="button">Act</button>}><p>inside</p></Group>);
    expect(out).toMatch(/<section class="group" aria-labelledby="([^"]+)"/);
    const id = /aria-labelledby="([^"]+)"/.exec(out)?.[1] ?? "";
    expect(out).toContain(`<h3 class="group-title" id="${id}">Status</h3>`);
    expect(out).toMatch(/<div class="group-head">.*<button type="button">Act<\/button><\/div>/);
    expect(out).toContain("<p>inside</p>");
  });

  it("puts a field's label beside its value, or above it when wide", () => {
    expect(renderToStaticMarkup(<Kv label="Due">x</Kv>)).toBe('<div class="kv"><div class="kv-k kicker">Due</div><div class="kv-v">x</div></div>');
    expect(renderToStaticMarkup(<Kv label="Due" wide>x</Kv>)).toContain('class="kv kv-wide"');
  });

  it("says a status in a word beside its dot, and hides the dot", () => {
    const on = renderToStaticMarkup(<StatusWord on>On</StatusWord>);
    expect(on).toContain('aria-hidden="true"></span>On</span>');
    expect(on).toContain("led-on");
    const off = renderToStaticMarkup(<StatusWord on={false}>Off</StatusWord>);
    expect(off).toContain('aria-hidden="true"></span>Off</span>');
    expect(off).toContain("led-off");
  });
});

describe("detail.css", () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("names no colour of its own and no em-dash", () => {
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,6}\b|\brgba?\(\s*\d/);
    expect(css).not.toContain(String.fromCharCode(0x2014));
  });

  it("shows an editable as editable on hover, and rings it when it has the keyboard", () => {
    expect(bare).toMatch(/\.group \.editable:hover[^{]*\{[^}]*outline-color: var\(--vemi-edge\)/);
    expect(bare).toMatch(/\.group \.editable:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--vemi-live\)/);
    expect(bare).toMatch(/\.group \.editing:focus[^{]*\{[^}]*box-shadow/);
  });

  it("stacks a field's label over its value on a phone, with the one phone query", () => {
    const phone = "@media (max-width: 719px), (pointer: coarse) and (max-height: 500px)";
    expect(bare).toContain(phone);
    expect(bare.slice(bare.indexOf(phone))).toMatch(/\.kv \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });
});
