/**
 * What a person's own Claude or ChatGPT may do in VEMI: the tools behind `POST /mcp`.
 *
 * Every tool goes through the same store functions the app's routes use, for the one
 * account the token stands for, and tells the live channel what it changed exactly as a
 * route does. There is no tool that removes or archives anything: the app's archive and
 * its undo stay the person's own hand.
 *
 * Names stay fixed. The words a person has chosen for the levels (space, project,
 * milestone, task) are read into each description, so the same tool says the same thing
 * the screen does.
 */
import { isSealed, parse, parseRepeat,pluralOf, type Change, type Kind, type SearchKind, SEARCH_KINDS } from "@vemi/shared";
import { isWallTime, type Outcome, type Store, type Written } from "./store.js";
import { isDate, parseCreate, parsePatch } from "./validate.js";

/** The four level words, as the person's account says them. */
export interface LevelWords {
  readonly space: string;
  readonly project: string;
  readonly milestone: string;
  readonly task: string;
}

export const DEFAULT_WORDS: LevelWords = { space: "Space", project: "Project", milestone: "Milestone", task: "Task" };

export type Gate = (owner: string) => Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;

/** The one place a plan or an encryption mode can say no to every tool. Today it always allows. */
export const connectorGate: Gate = async () => ({ allowed: true });

/** One thing a write tool did, as it is kept so the person can undo it. */
export interface ChangeNote {
  readonly tool: string;
  readonly kind: Kind;
  readonly recordId: string;
  /** The record before the write, or null when the write made it. */
  readonly before: unknown;
}

export interface ToolDeps {
  readonly store: Store;
  /** Keeps what a write did. Left out, nothing is kept (reads, and tests of other things). */
  readonly record?: (owner: string, note: ChangeNote) => Promise<void>;
  readonly now: () => Date;
  /** The zone "today" is read in when a call names none. */
  readonly timeZone: string;
  /** Tells the person's open screens what changed. */
  readonly publish: (owner: string, change: Change) => void | Promise<void>;
  readonly gate?: Gate;
}

export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: true;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: "object"; readonly properties: Record<string, unknown>; readonly required: readonly string[]; readonly additionalProperties: false };
  readonly annotations: { readonly readOnlyHint: boolean };
}

/** A plain sentence for the model to read back to the person. */
class ToolError extends Error {}

type Args = Record<string, unknown>;
interface Field { readonly type: "string" | "boolean"; readonly required?: true; readonly about: string }
interface Tool {
  readonly name: string;
  readonly readOnly: boolean;
  readonly describe: (w: LevelWords) => string;
  readonly fields: (w: LevelWords) => Record<string, Field>;
  readonly run: (c: Call, args: Args) => Promise<unknown>;
}
interface Call {
  readonly deps: ToolDeps;
  readonly owner: string;
  readonly words: LevelWords;
  readonly zone: string;
  readonly today: string;
  readonly tool: string;
}

function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const lower = (s: string): string => s.toLowerCase();
const plural = (s: string): string => pluralOf(lower(s));
const ZONE: Field = { type: "string", about: "Your time zone, such as Australia/Sydney, so today is your today." };

function validZone(name: string): boolean {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: name }); return true; } catch { return false; }
}

const fail = (message: string): never => { throw new ToolError(message); };

/** A locked part is never read out: the app is told it is locked and nothing else. */
const LOCKED = { locked: true } as const;
const veiled = (text: string | null): string | null | typeof LOCKED => (text !== null && isSealed(text) ? LOCKED : text);

const LOCKABLE_KEYS = ["body", "description", "whoFor", "doneLooks", "openQuestions"] as const;

/** A record as a tool answers with it: every sealed part is told as locked, never as its envelope. */
function veilRecord<T extends object>(record: T): T {
  const out = { ...record } as Record<string, unknown>;
  for (const key of LOCKABLE_KEYS) {
    const v = out[key];
    if (typeof v === "string" && isSealed(v)) out[key] = LOCKED;
  }
  return out as T;
}

function text(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}
function need(args: Args, key: string): string {
  const v = text(args, key);
  return v === undefined || v.trim() === "" ? fail(`${key} is needed`) : v.trim();
}

/** Lets the writes and the store speak for themselves: the store's and validator's own sentence is the error. */
function good<T>(outcome: Outcome<T> | { ok: true; value: T } | { ok: false; error: string }): T {
  return outcome.ok ? outcome.value : fail(outcome.error);
}

const NONE = new Set(["", "none", "no", "never", "clear"]);

function whenOf(value: string, c: Call): string | null {
  const v = value.trim();
  if (NONE.has(v.toLowerCase())) return null;
  if (isDate(v)) return v;
  const found = parse(`x ${v}`, c.deps.now(), c.zone).when;
  return found ?? fail("when must be a date like 2026-11-20, or a day like tomorrow or friday");
}

function reminderOf(value: string, c: Call): string | null {
  const v = value.trim();
  if (NONE.has(v.toLowerCase())) return null;
  if (isWallTime(v)) return v;
  const found = parse(`x ${v}`, c.deps.now(), c.zone).remindAt;
  return found ?? fail("reminder must be a time like 2026-11-20T09:00, or words like tomorrow at 9am");
}

function repeatOf(value: string, c: Call): string | null {
  const v = value.trim();
  if (NONE.has(v.toLowerCase())) return null;
  if (parseRepeat(v) !== null) return v;
  const found = parse(`x ${v}`, c.deps.now(), c.zone).repeat;
  return found ?? fail("repeat must be day, weekday, week:1 to week:7, month, or words like every monday");
}

function pointOf<T extends { id: string; name: string }>(list: readonly T[], ref: string, what: string): T {
  const wanted = ref.trim().toLowerCase();
  const byId = list.find((x) => x.id === ref.trim());
  if (byId !== undefined) return byId;
  const named = list.filter((x) => x.name.trim().toLowerCase() === wanted);
  if (named.length === 1) return named[0] as T;
  if (named.length > 1) return fail(`more than one ${lower(what)} is called ${ref}; use its id`);
  return fail(`no ${lower(what)} is called ${ref}`);
}

async function tree(c: Call) {
  return c.deps.store.tree(c.owner);
}

async function findSpace(c: Call, ref: string) {
  return pointOf((await tree(c)).ventures, ref, c.words.space);
}

async function findProject(c: Call, ref: string, spaceRef?: string) {
  const t = await tree(c);
  const ventures = spaceRef === undefined ? t.ventures : [pointOf(t.ventures, spaceRef, c.words.space)];
  const all = ventures.flatMap((v) => v.projects);
  return pointOf(all, ref, c.words.project);
}

async function findTask(c: Call, ref: string) {
  const task = await c.deps.store.get(c.owner, "tasks", ref.trim());
  if (task === null) return fail(`${lower(c.words.task)} ${ref} was not found`);
  if (task.archivedAt !== null) return fail(`${lower(c.words.task)} ${ref} is archived; restore it in VEMI first`);
  return task;
}

/** Tells every open screen, as the app's own routes do, including a repeat's next one. */
async function told<T extends { id: string }>(c: Call, kind: Kind, outcome: Outcome<Written<T>>, before: unknown = null): Promise<T> {
  const done = good(outcome);
  if (done.replayed !== true) {
    await c.deps.record?.(c.owner, { tool: c.tool, kind, recordId: done.record.id, before });
    c.deps.publish(c.owner, { kind, id: done.record.id, ventureId: done.ventureId });
    if (done.spawned !== undefined) {
      await c.deps.record?.(c.owner, { tool: c.tool, kind: "tasks", recordId: done.spawned.id, before: null });
      c.deps.publish(c.owner, { kind: "tasks", id: done.spawned.id, ventureId: done.ventureId });
    }
  }
  return veilRecord(done.record);
}

async function patchTask(c: Call, id: string, body: Args) {
  const patch = good(parsePatch("tasks", body));
  const before = await c.deps.store.get(c.owner, "tasks", id);
  return told(c, "tasks", await c.deps.store.update(c.owner, "tasks", id, patch, c.today), before);
}

const TASK_BITS = (w: LevelWords): Record<string, Field> => ({
  when: { type: "string", about: `A date like 2026-11-20 or a day like tomorrow; "none" clears it.` },
  reminder: { type: "string", about: `A time like 2026-11-20T09:00 or words like tomorrow at 9am; "none" clears it.` },
  repeat: { type: "string", about: `day, weekday, week:1 to week:7, month, or words like every monday; "none" clears it.` },
  project: { type: "string", about: `The ${lower(w.project)}'s name or id.` },
  milestone: { type: "string", about: `The ${lower(w.milestone)}'s name or id, inside the ${lower(w.project)}.` },
});

const TOOLS: readonly Tool[] = [
  {
    name: "overview", readOnly: true,
    describe: (w) => `Lists each ${lower(w.space)} with how much is underway, blocked and left.`,
    fields: () => ({}),
    async run(c) {
      const o = await c.deps.store.overview(c.owner);
      return o.ventures.map((v) => ({
        id: v.id, name: v.name, parentId: v.parentId,
        underway: v.own.underway, blocked: v.own.blocked, left: v.own.tasksLeft,
      }));
    },
  },
  {
    name: "today", readOnly: true,
    describe: (w) => `Lists the ${plural(w.task)} picked for today, and what else is due.`,
    fields: () => ({ timeZone: ZONE }),
    async run(c) {
      const t = await c.deps.store.today(c.owner, c.today);
      return {
        on: t.on,
        tasks: t.tasks.map((x) => ({
          id: x.id, title: x.title, ventureId: x.ventureId, projectId: x.projectId, stateKind: x.stateKind,
          picked: x.picked, dueOn: x.dueOn, remindAt: x.remindAt, repeat: x.repeat,
        })),
      };
    },
  },
  {
    name: "search", readOnly: true,
    describe: (w) => `Finds ${plural(w.space)}, ${plural(w.project)}, ${plural(w.milestone)}, ${plural(w.task)} and notes by the words in them.`,
    fields: () => ({
      text: { type: "string", required: true, about: "The words to look for." },
      scope: { type: "string", about: `One of ${SEARCH_KINDS.join(", ")} to keep only that kind.` },
    }),
    async run(c, args) {
      const q = need(args, "text");
      const scope = text(args, "scope");
      if (scope !== undefined && !(SEARCH_KINDS as readonly string[]).includes(scope)) {
        return fail(`scope must be one of ${SEARCH_KINDS.join(", ")}`);
      }
      const hits = await c.deps.store.search(c.owner, q);
      return scope === undefined ? hits : hits.filter((h) => h.kind === (scope as SearchKind));
    },
  },
  {
    name: "get_project", readOnly: true,
    describe: (w) => `Reads one ${lower(w.project)}: its brief, ${plural(w.milestone)}, ${plural(w.task)} and latest notes.`,
    fields: (w) => ({ project: { type: "string", required: true, about: `The ${lower(w.project)}'s name or id.` } }),
    async run(c, args) {
      const p = await findProject(c, need(args, "project"));
      const notes = good(await c.deps.store.list(c.owner, "notes", { project: p.id })).slice(0, 5);
      return {
        id: p.id, name: p.name, ventureId: p.ventureId,
        brief: { description: veiled(p.description), whoFor: veiled(p.whoFor), doneLooks: veiled(p.doneLooks), openQuestions: veiled(p.openQuestions) },
        milestones: p.milestones.map((m) => ({ id: m.id, name: m.name, stateId: m.stateId })),
        tasks: p.tasks.map((x) => ({ id: x.id, title: x.title, stateId: x.stateId, milestoneId: x.milestoneId, dueOn: x.dueOn, pickedOn: x.pickedOn })),
        notes: notes.map((n) => (isSealed(n.body) ? { id: n.id, ...LOCKED } : { id: n.id, body: n.body, updatedAt: n.updatedAt })),
      };
    },
  },
  {
    name: "get_task", readOnly: true,
    describe: (w) => `Reads one ${lower(w.task)} with its dates, reminder, repeat and checklist.`,
    fields: (w) => ({ task: { type: "string", required: true, about: `The ${lower(w.task)}'s id.` } }),
    async run(c, args) {
      const id = need(args, "task");
      const t = await c.deps.store.get(c.owner, "tasks", id);
      if (t === null) return fail(`${lower(c.words.task)} ${id} was not found`);
      return { ...t, body: veiled(t.body) };
    },
  },
  {
    name: "add_task", readOnly: false,
    describe: (w) => `Adds a ${lower(w.task)} from a title, reading dates like "tomorrow" or "every monday" out of it.`,
    fields: (w) => ({
      title: { type: "string", required: true, about: `The ${lower(w.task)}'s title.` },
      space: { type: "string", about: `The ${lower(w.space)}'s name or id; left out, the one new ${plural(w.task)} go to.` },
      ...TASK_BITS(w), timeZone: ZONE,
    }),
    async run(c, args) {
      const smart = parse(need(args, "title"), c.deps.now(), c.zone);
      const t = await tree(c);
      const projectRef = text(args, "project");
      const spaceRef = text(args, "space");
      const project = projectRef === undefined ? null : await findProject(c, projectRef, spaceRef);
      let ventureId: string;
      if (project !== null) ventureId = project.ventureId;
      else if (spaceRef !== undefined) ventureId = pointOf(t.ventures, spaceRef, c.words.space).id;
      else {
        const chosen = (await c.deps.store.appearance(c.owner)).newTaskVentureId;
        const live = t.ventures.find((v) => v.id === chosen) ?? (t.ventures.length === 1 ? t.ventures[0] : undefined);
        ventureId = live?.id ?? fail(`say which ${lower(c.words.space)} it belongs in`);
      }
      const milestoneRef = text(args, "milestone");
      if (milestoneRef !== undefined && project === null) fail(`a ${lower(c.words.milestone)} needs its ${lower(c.words.project)}`);
      const body: Args = { ventureId, title: smart.title };
      if (project !== null) body.projectId = project.id;
      if (project !== null && milestoneRef !== undefined) body.milestoneId = pointOf(project.milestones, milestoneRef, c.words.milestone).id;
      const when = text(args, "when") === undefined ? smart.when : whenOf(text(args, "when") as string, c);
      const reminder = text(args, "reminder") === undefined ? smart.remindAt : reminderOf(text(args, "reminder") as string, c);
      const repeat = text(args, "repeat") === undefined ? smart.repeat : repeatOf(text(args, "repeat") as string, c);
      if (when !== null) body.dueOn = when;
      if (reminder !== null) body.remindAt = reminder;
      if (repeat !== null) body.repeat = repeat;
      const input = good(parseCreate("tasks", body));
      return told(c, "tasks", await c.deps.store.create(c.owner, "tasks", input));
    },
  },
  {
    name: "update_task", readOnly: false,
    describe: (w) => `Changes a ${lower(w.task)}'s title, date, reminder, repeat, ${lower(w.project)} or ${lower(w.milestone)}.`,
    fields: (w) => ({
      task: { type: "string", required: true, about: `The ${lower(w.task)}'s id.` },
      title: { type: "string", about: "The new title." },
      ...TASK_BITS(w), timeZone: ZONE,
    }),
    async run(c, args) {
      const task = await findTask(c, need(args, "task"));
      const body: Args = {};
      if (text(args, "title") !== undefined) body.title = need(args, "title");
      if (text(args, "when") !== undefined) body.dueOn = whenOf(text(args, "when") as string, c);
      if (text(args, "reminder") !== undefined) body.remindAt = reminderOf(text(args, "reminder") as string, c);
      if (text(args, "repeat") !== undefined) body.repeat = repeatOf(text(args, "repeat") as string, c);
      const projectRef = text(args, "project");
      const milestoneRef = text(args, "milestone");
      if (projectRef !== undefined) {
        if (NONE.has(projectRef.trim().toLowerCase())) { body.projectId = null; body.milestoneId = null; }
        else {
          const p = await findProject(c, projectRef);
          body.projectId = p.id;
          body.milestoneId = milestoneRef === undefined ? null : pointOf(p.milestones, milestoneRef, c.words.milestone).id;
        }
      } else if (milestoneRef !== undefined) {
        if (task.projectId === null) return fail(`a ${lower(c.words.milestone)} needs its ${lower(c.words.project)}`);
        const p = await findProject(c, task.projectId);
        body.milestoneId = NONE.has(milestoneRef.trim().toLowerCase()) ? null : pointOf(p.milestones, milestoneRef, c.words.milestone).id;
      }
      return patchTask(c, task.id, body);
    },
  },
  {
    name: "complete_task", readOnly: false,
    describe: (w) => `Marks a ${lower(w.task)} finished, or not finished again when done is false.`,
    fields: (w) => ({
      task: { type: "string", required: true, about: `The ${lower(w.task)}'s id.` },
      done: { type: "boolean", about: "True to finish it, false to reopen it; true when left out." },
      timeZone: ZONE,
    }),
    async run(c, args) {
      const task = await findTask(c, need(args, "task"));
      const done = args.done === undefined ? true : args.done === true;
      const space = (await tree(c)).ventures.find((v) => v.id === task.ventureId);
      const states = space?.states ?? [];
      const target = done
        ? states.find((s) => s.kind === "finished")
        : states.find((s) => s.kind === "not_started") ?? states.find((s) => s.kind !== "finished");
      if (target === undefined) return fail(`this ${lower(c.words.space)} has no ${done ? "finished" : "open"} state`);
      return patchTask(c, task.id, { stateId: target.id });
    },
  },
  {
    name: "pick_for_today", readOnly: false,
    describe: (w) => `Picks a ${lower(w.task)} for today, or takes it off today when on is false.`,
    fields: (w) => ({
      task: { type: "string", required: true, about: `The ${lower(w.task)}'s id.` },
      on: { type: "boolean", about: "True to pick it, false to take it off; true when left out." },
      timeZone: ZONE,
    }),
    async run(c, args) {
      const task = await findTask(c, need(args, "task"));
      return patchTask(c, task.id, { pickedOn: args.on === false ? null : c.today });
    },
  },
  {
    name: "add_project", readOnly: false,
    describe: (w) => `Adds a ${lower(w.project)} to a ${lower(w.space)}.`,
    fields: (w) => ({
      space: { type: "string", required: true, about: `The ${lower(w.space)}'s name or id.` },
      name: { type: "string", required: true, about: `The ${lower(w.project)}'s name.` },
    }),
    async run(c, args) {
      const space = await findSpace(c, need(args, "space"));
      const input = good(parseCreate("projects", { ventureId: space.id, name: need(args, "name") }));
      return told(c, "projects", await c.deps.store.create(c.owner, "projects", input));
    },
  },
  {
    name: "add_note", readOnly: false,
    describe: (w) => `Adds a note to a ${lower(w.project)}.`,
    fields: (w) => ({
      project: { type: "string", required: true, about: `The ${lower(w.project)}'s name or id.` },
      text: { type: "string", required: true, about: "The note." },
    }),
    async run(c, args) {
      const p = await findProject(c, need(args, "project"));
      const input = good(parseCreate("notes", { projectId: p.id, body: need(args, "text") }));
      return told(c, "notes", await c.deps.store.create(c.owner, "notes", input));
    },
  },
  {
    name: "update_brief", readOnly: false,
    describe: (w) => `Rewrites one part of a ${lower(w.project)}'s brief: description, whoFor, doneLooks or openQuestions.`,
    fields: (w) => ({
      project: { type: "string", required: true, about: `The ${lower(w.project)}'s name or id.` },
      field: { type: "string", required: true, about: "description, whoFor, doneLooks or openQuestions." },
      text: { type: "string", required: true, about: "What it should now say." },
    }),
    async run(c, args) {
      const field = need(args, "field");
      if (!["description", "whoFor", "doneLooks", "openQuestions"].includes(field)) {
        return fail("field must be description, whoFor, doneLooks or openQuestions");
      }
      const p = await findProject(c, need(args, "project"));
      const patch = good(parsePatch("projects", { [field]: need(args, "text") }));
      const before = await c.deps.store.get(c.owner, "projects", p.id);
      const now = before?.[field as "description" | "whoFor" | "doneLooks" | "openQuestions"];
      if (typeof now === "string" && isSealed(now)) return fail("That part is locked, so an AI app can't change it.");
      return told(c, "projects", await c.deps.store.update(c.owner, "projects", p.id, patch, c.today), before);
    },
  },
];

export function toolList(words: LevelWords = DEFAULT_WORDS): ToolInfo[] {
  return TOOLS.map((t) => {
    const fields = t.fields(words);
    return {
      name: t.name,
      description: t.describe(words),
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { type: f.type, description: f.about }])),
        required: Object.entries(fields).filter(([, f]) => f.required === true).map(([k]) => k),
        additionalProperties: false,
      },
      annotations: { readOnlyHint: t.readOnly },
    };
  });
}

const reply = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refuse = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Runs one tool for one account. Null when there is no tool of that name. */
export async function callTool(
  deps: ToolDeps, owner: string, name: string, given: unknown, words: LevelWords = DEFAULT_WORDS,
): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return null;
  const gate = await (deps.gate ?? connectorGate)(owner);
  if (!gate.allowed) return refuse(gate.reason);
  try {
    if (given !== undefined && (typeof given !== "object" || given === null || Array.isArray(given))) fail("the arguments must be an object");
    const args = (given ?? {}) as Args;
    const fields = tool.fields(words);
    for (const key of Object.keys(args)) if (!(key in fields)) fail(`${name} has no argument ${key}`);
    for (const [key, f] of Object.entries(fields)) {
      const v = args[key];
      if (v === undefined) { if (f.required === true) fail(`${key} is needed`); continue; }
      if (typeof v !== f.type) fail(`${key} must be ${f.type === "string" ? "text" : "true or false"}`);
    }
    // A call that names no zone reads the day in the account's own zone, else the Worker's.
    const zone = text(args, "timeZone") ?? (await deps.store.appearance(owner)).timeZone ?? deps.timeZone;
    if (!validZone(zone)) fail("timeZone must be a name like Australia/Sydney");
    const today = localDate(deps.now(), zone);
    return reply(await tool.run({ deps, owner, words, zone, today, tool: name }, args));
  } catch (e) {
    if (e instanceof ToolError) return refuse(e.message);
    throw e;
  }
}
