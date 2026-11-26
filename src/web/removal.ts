/**
 * What a delete takes with it, in words. Pure: counts in, lines out.
 *
 * Decision 33 asks for the cascade to be named before it happens. A row of ten numbers is
 * not naming it, so this drops the zeros, drops the record itself, and writes what is left
 * the way a person would say it.
 */
import type { Kind, Removal } from "@vemi/shared";

/**
 * The order they are read in: the biggest containers first, the loose ends last.
 *
 * `kind` is the kind a count is of, so the record being deleted can be left out of its own
 * list. An assignment is of no kind — it is never the record named — so it carries null and
 * is always said.
 */
const PARTS: readonly { readonly key: keyof Removal; readonly kind: Kind | null; readonly one: string; readonly many: string }[] = [
  { key: "ventures", kind: "ventures", one: "venture", many: "ventures" },
  { key: "projects", kind: "projects", one: "project", many: "projects" },
  { key: "milestones", kind: "milestones", one: "milestone", many: "milestones" },
  { key: "tasks", kind: "tasks", one: "task", many: "tasks" },
  { key: "states", kind: "states", one: "state", many: "states" },
  { key: "stages", kind: "stages", one: "lifecycle stage", many: "lifecycle stages" },
  { key: "blockers", kind: "blockers", one: "blocker", many: "blockers" },
  { key: "notes", kind: "notes", one: "note", many: "notes" },
  { key: "decisions", kind: "decisions", one: "decision", many: "decisions" },
  { key: "risks", kind: "risks", one: "risk", many: "risks" },
  { key: "links", kind: "links", one: "link", many: "links" },
  { key: "tags", kind: "tags", one: "tag", many: "tags" },
  // An assignment, not the thing it was on. Its words depend on what is being deleted; see
  // `assignment`. These are what is said if nothing more particular fits.
  { key: "taskTags", kind: null, one: "tag on a task", many: "tags on tasks" },
  { key: "projectTags", kind: null, one: "tag on a project", many: "tags on projects" },
];

/**
 * A tag assignment, said from where the sheet stands, because a count of assignments is not
 * a count of tasks. "2 tags on tasks" on the sheet for one task carrying two tags read as
 * though other tasks were involved.
 *
 * - Deleting a tag: each assignment is that one tag on one task or project (an assignment is
 *   unique), so the count is of tasks, and the words say the tag's place on them. The task
 *   and the project both stay, and a sheet headed by a tag's name never reads as though the
 *   work goes with it.
 * - Deleting a task or a project: its own assignments are "on it".
 * - Deleting a venture or a project: its tasks' assignments are "on its tasks", its
 *   projects' "on its projects" — counted as tags, which is what they are.
 */
function assignment(key: "taskTags" | "projectTags", kind: Kind, n: number): string | null {
  const on = key === "taskTags" ? "tasks" : "projects";
  const own = key === "taskTags" ? kind === "tasks" : kind === "projects";
  const tags = n === 1 ? "1 tag" : `${n} tags`;
  if (kind === "tags") return `its place on ${n} ${n === 1 ? on.slice(0, -1) : on}`;
  if (own) return `${tags} on it`;
  if (kind === "ventures" || kind === "projects") return `${tags} on its ${on}`;
  return null;
}

/**
 * Everything the delete removes besides the record itself, as "3 tasks", "1 project".
 *
 * The record's own kind is left out: the sheet has already named it, and "1 venture" in a
 * list headed by that venture's name reads as a second one.
 */
export function alsoRemoved(kind: Kind, removes: Removal): string[] {
  const out: string[] = [];
  for (const part of PARTS) {
    const n = removes[part.key];
    if (n <= 0) continue;
    // One of the record's own kind is the record. More than one happens for a project with
    // projects inside it: the rest are said, and the record itself is still dropped.
    const rest = part.kind === kind ? n - 1 : n;
    if (rest <= 0) continue;
    if (part.kind === kind) {
      out.push(`${rest} ${rest === 1 ? part.one : part.many} inside it`);
      continue;
    }
    const said = part.key === "taskTags" || part.key === "projectTags" ? assignment(part.key, kind, n) : null;
    out.push(said ?? `${n} ${n === 1 ? part.one : part.many}`);
  }
  return out;
}
