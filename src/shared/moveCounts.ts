/**
 * What a move brought over, as lines in the person's own level names. Pure.
 *
 * Restore counts are keyed by table name. Only the four levels are told back; every other
 * kind is left out. The names come in as an argument, so none is typed here.
 */

export interface MoveWords {
  readonly space: string;
  readonly spaces: string;
  readonly project: string;
  readonly projects: string;
  readonly milestone: string;
  readonly milestones: string;
  readonly task: string;
  readonly tasks: string;
}

type Level = "space" | "project" | "milestone" | "task";

const LEVELS: readonly { readonly table: string; readonly level: Level }[] = [
  { table: "venture", level: "space" },
  { table: "project", level: "project" },
  { table: "milestone", level: "milestone" },
  { table: "task", level: "task" },
];

/** One line a level that has rows, in level order, such as `2 Realms` or `1 Quest`. */
export function moveLines(counts: Readonly<Record<string, number>>, words: MoveWords): string[] {
  const lines: string[] = [];
  for (const { table, level } of LEVELS) {
    const n = counts[table] ?? 0;
    if (!(n > 0)) continue;
    lines.push(`${n} ${n === 1 ? words[level] : words[`${level}s` as const]}`);
  }
  return lines;
}
