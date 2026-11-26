import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, startLight } from "./theme.js";

/** A stylesheet that keeps the text it was last given. */
class FakeSheet {
  text = "";
  replaceSync(text: string): void {
    this.text = text;
  }
}

interface FakeStyle { id: string; textContent: string; removed: boolean; remove(): void }

/** A document with only what `applyTheme` touches, and the element a fallback would write. */
function page(options: { adopted: boolean }) {
  const styles: FakeStyle[] = [];
  const meta = { content: "" };
  const attrs = new Map<string, string>();
  const doc: Record<string, unknown> = {
    head: { appendChild: (el: FakeStyle) => styles.push(el) },
    getElementById: (id: string) => styles.find((s) => s.id === id && !s.removed) ?? null,
    createElement: () => ({ id: "", textContent: "", removed: false, remove() { this.removed = true; } }),
    querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? { setAttribute: (_k: string, v: string) => { meta.content = v; } } : null),
  };
  if (options.adopted) doc.adoptedStyleSheets = [];
  const root = { ownerDocument: doc, setAttribute: (k: string, v: string) => attrs.set(k, v) };
  return { doc, root: root as unknown as HTMLElement, styles, meta, attrs };
}

afterEach(() => vi.unstubAllGlobals());

describe("applyTheme, where the browser has constructed stylesheets", () => {
  it("writes both tables into one adopted sheet, with no style element", () => {
    vi.stubGlobal("CSSStyleSheet", FakeSheet);
    const { doc, root, styles, attrs } = page({ adopted: true });
    applyTheme(root, "dark", "ember");
    const sheets = doc.adoptedStyleSheets as FakeSheet[];
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.text).toContain(':root[data-theme="dark"]');
    expect(sheets[0]?.text).toContain("--vemi-live:");
    expect(styles).toHaveLength(0);
    expect(attrs.get("data-theme")).toBe("dark");
  });

  it("replaces the rules on a second call rather than stacking a second sheet", () => {
    vi.stubGlobal("CSSStyleSheet", FakeSheet);
    const { doc, root } = page({ adopted: true });
    applyTheme(root, "light", "ember");
    const first = (doc.adoptedStyleSheets as FakeSheet[])[0]?.text ?? "";
    applyTheme(root, "light", "ocean");
    const sheets = doc.adoptedStyleSheets as FakeSheet[];
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.text).not.toBe(first);
  });

  it("removes the vemi-tokens element an earlier fallback left behind", () => {
    vi.stubGlobal("CSSStyleSheet", FakeSheet);
    const { root, styles } = page({ adopted: true });
    styles.push({ id: "vemi-tokens", textContent: "old", removed: false, remove() { this.removed = true; } });
    applyTheme(root, "light", "ember");
    expect(styles[0]?.removed).toBe(true);
  });
});

describe("applyTheme, where the browser has none", () => {
  it("writes one vemi-tokens style element and rewrites it on a second call", () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    const { root, styles, meta } = page({ adopted: false });
    applyTheme(root, "light", "ember");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.id).toBe("vemi-tokens");
    const first = styles[0]?.textContent ?? "";
    expect(first).toContain(':root[data-theme="dark"]');
    applyTheme(root, "dark", "ocean");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).not.toBe(first);
    expect(meta.content).not.toBe("");
  });

  it("falls back to the element when the sheet cannot be written", () => {
    class Broken { replaceSync(): void { throw new Error("blocked"); } }
    vi.stubGlobal("CSSStyleSheet", Broken);
    const { root, styles } = page({ adopted: true });
    applyTheme(root, "light", "ember");
    expect(styles).toHaveLength(1);
  });
});

describe("startLight, for the pages before the app", () => {
  /** The theme the page ends up with, for a device that prefers dark or not and a storage that holds what it is given. */
  function modeFor(stored: string | null | "throws", dark: boolean): string | undefined {
    vi.stubGlobal("CSSStyleSheet", FakeSheet);
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: dark, addEventListener: () => undefined }),
      localStorage: { getItem: () => { if (stored === "throws") throw new Error("blocked"); return stored; } },
    });
    const { root, attrs } = page({ adopted: true });
    startLight(root);
    return attrs.get("data-theme");
  }

  it("starts light with nothing stored, even on a device set to dark", () => {
    expect(modeFor(null, true)).toBe("light");
    expect(modeFor(null, false)).toBe("light");
  });
  it("starts light when the storage cannot be read or holds something else", () => {
    expect(modeFor("throws", true)).toBe("light");
    expect(modeFor("not json", true)).toBe("light");
    expect(modeFor(JSON.stringify({ theme: "light" }), true)).toBe("light");
    expect(modeFor(JSON.stringify({ theme: 4 }), true)).toBe("light");
  });
  it("goes dark when a stored choice says dark", () => {
    expect(modeFor(JSON.stringify({ theme: "dark", accent: "ember" }), false)).toBe("dark");
  });
  it("follows the device only when the stored choice is match device", () => {
    expect(modeFor(JSON.stringify({ theme: "system" }), true)).toBe("dark");
    expect(modeFor(JSON.stringify({ theme: "system" }), false)).toBe("light");
  });
});
