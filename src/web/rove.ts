/** What a key handler is handed, as much of it as these read. A keyboard event is one. */
export interface Press {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/**
 * A key held with Alt, Ctrl or Cmd belongs to the browser or the system, not the list: Alt and
 * an arrow is Back and Forward, Ctrl and Page Down the next tab. Shift is not one of them.
 */
export function chorded(press: Press): boolean {
  return press.altKey || press.ctrlKey || press.metaKey;
}

/**
 * Moving the focus through a short list by key: a ⋯ menu's lines. Down and up step and go
 * round at the ends, Home and End jump to them. Pure, so the arithmetic is provable without
 * a page; the menu does the focusing.
 *
 * Null for any other key, for one held with Alt, Ctrl or Cmd, and for an empty list, so the
 * key goes on to whatever else wants it.
 */
export function roveTo(press: Press, at: number, count: number): number | null {
  if (count === 0 || chorded(press)) return null;
  switch (press.key) {
    case "ArrowDown": return at < 0 ? 0 : (at + 1) % count;
    case "ArrowUp": return at < 0 ? count - 1 : (at - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/**
 * The same for a row of tabs, which run across: right and left step and go round at the ends,
 * Home and End jump to them. Null for any other key, a chorded one, and no tabs.
 */
export function tabTo(press: Press, at: number, count: number): number | null {
  if (count === 0 || chorded(press)) return null;
  switch (press.key) {
    case "ArrowRight": return at < 0 ? 0 : (at + 1) % count;
    case "ArrowLeft": return at < 0 ? count - 1 : (at - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}
