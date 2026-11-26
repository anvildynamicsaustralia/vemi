import type { LevelWords } from "./levelWords.js";

/** A key beside what it does. */
export type ShortcutRow = readonly [keys: string, what: string];

/**
 * The rows of the shortcuts sheet. Pure. The keys that are one press are listed only while
 * the single-key switch is on; `Cmd/Ctrl K` and `Esc` work either way, so they are always there.
 */
export function shortcutRows(mod: string, words: LevelWords, singleKeys: boolean): readonly ShortcutRow[] {
  const palette: ShortcutRow = [`${mod} K`, "Open or close the palette"];
  const close: ShortcutRow = ["Esc", "Close the top layer"];
  if (!singleKeys) return [palette, close];
  return [
    palette,
    ["/", "Search"],
    ["N", `New ${words.task.toLowerCase()}`],
    ["P", `New ${words.project.toLowerCase()}`],
    ["G then M", "Map"],
    ["G then T", "Today"],
    ["G then S", "Search"],
    ["G then A", "Archive"],
    ["1  2", `Board and ${words.projects.toLowerCase()}, inside a ${words.space.toLowerCase()}`],
    ["?", "This list"],
    close,
  ];
}
