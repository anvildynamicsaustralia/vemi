import { COLOUR_TOKENS, THEMES, withAccent, type AccentName, type Theme, type ThemeName } from "@vemi/shared";

/** The element that holds the two tables, so a second call replaces it rather than stacking. */
const STYLE_ID = "vemi-tokens";

/** The one sheet the tables live in, per document, so a second call replaces its rules. */
const SHEETS = new WeakMap<Document, CSSStyleSheet>();

/**
 * Puts the tables in a constructed stylesheet, which a policy of `style-src 'self'` permits (it
 * blocks a `<style>` element's text and a `style` attribute, not the stylesheet object model).
 * False where the browser cannot, and the caller writes a `<style>` element instead.
 */
function adopt(doc: Document, text: string): boolean {
  if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype) || !("adoptedStyleSheets" in doc)) return false;
  try {
    let sheet = SHEETS.get(doc);
    if (sheet === undefined) {
      sheet = new CSSStyleSheet();
      SHEETS.set(doc, sheet);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    }
    sheet.replaceSync(text);
    doc.getElementById(STYLE_ID)?.remove();
    return true;
  } catch {
    return false;
  }
}

function block(selector: string, table: Theme, scheme: ThemeName): string {
  const lines = COLOUR_TOKENS.map((key) => `  --vemi-${key}: ${table[key]};`);
  return `${selector} {\n  color-scheme: ${scheme};\n${lines.join("\n")}\n}`;
}

/**
 * Both tables as `--vemi-<token>` custom properties, selected by one attribute: `data-theme`
 * on the root. No component hard-codes a colour; each one reads these back, so the tables in
 * `src/shared/theme.ts` are the only place a colour is decided.
 *
 * The tables are written once, as a stylesheet, not as inline styles on the root: an inline
 * property beats any selector, so a second table could never win. Switching theme is then
 * the attribute alone. The accent is laid over both tables, so changing it rewrites the pair
 * of rules, and every `var(--vemi-live)` follows without a reload.
 *
 * VEMI-006 decision 2 (no `--vemi-on-map-*` set) stands: the map is the page's ground.
 */
export function applyTheme(
  root: HTMLElement = document.documentElement,
  mode: ThemeName = "light",
  accent: AccentName = "ember",
): void {
  const doc = root.ownerDocument;
  const tables = [
    block(':root, :root[data-theme="light"]', withAccent(THEMES.light, accent, "light"), "light"),
    block(':root[data-theme="dark"]', withAccent(THEMES.dark, accent, "dark"), "dark"),
  ].join("\n");
  if (!adopt(doc, tables)) {
    let style = doc.getElementById(STYLE_ID);
    if (style === null) {
      style = doc.createElement("style");
      style.id = STYLE_ID;
      doc.head.appendChild(style);
    }
    style.textContent = tables;
  }
  root.setAttribute("data-theme", mode);
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEMES[mode].page);
}

const DEVICE_DARK = "(prefers-color-scheme: dark)";

/**
 * Lays the tables on a page that has no account to ask, and follows the device between light
 * and dark. The setup page is that page: it runs before anyone has a copy to sign in to.
 */
export function followDevice(root: HTMLElement = document.documentElement): void {
  const query = window.matchMedia(DEVICE_DARK);
  const draw = (): void => applyTheme(root, query.matches ? "dark" : "light");
  draw();
  query.addEventListener("change", draw);
}

/** Where the app keeps the account's look on a device (the key `appearance.ts` writes). */
const CHOICE_KEY = "vemi:appearance:v1";

/** The theme mode this device has stored, or null when there is none it can read. */
function storedMode(): string | null {
  try {
    const raw = window.localStorage.getItem(CHOICE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    const mode = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["theme"] : null;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

/**
 * For the pages before the app (the setup page): light unless a choice stored on this device
 * says dark, and the device's own setting only where that choice is "match device". A device
 * set to dark does not turn these pages dark by itself.
 */
export function startLight(root: HTMLElement = document.documentElement): void {
  const mode = storedMode();
  if (mode === "dark") applyTheme(root, "dark");
  else if (mode === "system") followDevice(root);
  else applyTheme(root, "light");
}
