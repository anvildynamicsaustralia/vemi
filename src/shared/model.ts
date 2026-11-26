/**
 * The model, as it travels. VEMI-003 decisions, "The model".
 *
 * Ventures own projects, projects own milestones, and a task belongs to a venture and
 * optionally to a project and a milestone inside it. Every record a person makes can be
 * archived and restored; none can be deleted.
 *
 * Nothing here computes lateness. A milestone's `aimingOn` is soft and is only ever
 * ordered by. Overdue exists in exactly one place, a task's `overdue` in the today list.
 */

export const STATE_KINDS = ["not_started", "underway", "finished"] as const;
export type StateKind = (typeof STATE_KINDS)[number];

/** A lifecycle stage's kind. Shown as a word and read in one place: a project moving ventures. */
export const STAGE_KINDS = ["early", "active", "paused", "shipped", "stopped"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** The stages a new space starts with unless the account chose its own (decision 34). */
export const DEFAULT_NEW_STAGES: readonly { readonly name: string; readonly kind: StageKind }[] = [
  { name: "Idea", kind: "early" },
  { name: "Building", kind: "active" },
  { name: "Live", kind: "shipped" },
  { name: "Paused", kind: "paused" },
  { name: "Stopped", kind: "stopped" },
];

/** The views a space can switch on. At least one stays on. */
export const VENTURE_VIEWS = ["board", "projects"] as const;
export type VentureView = (typeof VENTURE_VIEWS)[number];

/** The screen a copy opens on. */
export const START_SCREENS = ["map", "today"] as const;
export type StartScreen = (typeof START_SCREENS)[number];

/** The Extras an account can switch. A switch never named is on. */
export const EXTRA_SWITCHES = ["smartDates", "singleKeys", "recent", "rings", "comingUp", "burst"] as const;
export type ExtraSwitch = (typeof EXTRA_SWITCHES)[number];
export type ExtraSwitches = { readonly [K in ExtraSwitch]: boolean };

/** What the four levels are called in one account, singular, as a person typed them. */
export interface AccountLevelNames {
  readonly space: string;
  readonly project: string;
  readonly milestone: string;
  readonly task: string;
}

export const PRIORITIES =["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** What a link points at: the repo, the docs, the site, or anything else. A word, never a status. */
export const LINK_ROLES = ["repo", "docs", "site", "other"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/**
 * A prefixed icon name, `lucide:rocket` or `brand:github`. Stored as given and never
 * checked against either set, so an unknown one renders as nothing.
 */
export type IconName = string;

/** `YYYY-MM-DD`. */
export type DateOnly = string;

interface Recorded {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface Venture extends Recorded {
  readonly name: string;
  readonly icon: IconName | null;
  /** What it is, in one sentence. A statement, never a number. */
  readonly description: string | null;
  /**
   * The order it is read in. Decision 5 sets this from where it sits on the board, top to
   * bottom and left to right, so it is written by a move rather than typed.
   */
  readonly position: number;
  /** Two levels at most: a venture with a parent may not have children. */
  readonly parentId: string | null;
  /** Which views of the space are on. At least one. */
  readonly views: readonly VentureView[];
  /** The letters its plate shows. Null means letters from its name. */
  readonly monogram: string | null;
  /**
   * One of the venture's own lifecycle stages, set by hand. Null means no stage and nothing is shown.
   * Nothing derives it.
   */
  readonly stageId: string | null;
  /**
   * Set by hand and nothing else: nothing derives it and nothing reads it except to show it.
   * Blocked, which is computed, wins the display.
   */
  readonly atRisk: boolean;
}

/** Named by the user; colour and progress read the kind, never the name. */
export interface State extends Recorded {
  readonly ventureId: string;
  readonly name: string;
  readonly kind: StateKind;
  readonly position: number;
}

/** A venture's own named point on its arc, typed by kind like a state. Not a status. */
export interface Stage extends Recorded {
  readonly ventureId: string;
  readonly name: string;
  readonly kind: StageKind;
  readonly position: number;
}

export interface Project extends Recorded {
  readonly ventureId: string;
  readonly name: string;
  readonly icon: IconName | null;
  /** What it is, in one sentence. A statement, never a number. */
  readonly description: string | null;
  readonly position: number;
  /** One level at most: a project with a parent may not hold projects. */
  readonly parentId: string | null;
  /**
   * One of its venture's lifecycle stages, set by hand. Null means no stage and nothing is shown.
   * Nothing derives it.
   */
  readonly stageId: string | null;
  /**
   * Set by hand and nothing else: nothing derives it and nothing reads it except to show it.
   * Blocked, which is computed, wins the display.
   */
  readonly atRisk: boolean;
  /** When it was pinned to the top of its plate, or null. Set by hand; nothing derives it. */
  readonly pinnedAt: string | null;
  /** The brief's other three steps, free text, null until written. */
  readonly whoFor: string | null;
  readonly doneLooks: string | null;
  readonly openQuestions: string | null;
}

/** One box's place on an account's canvas. A position belongs to the account, not the record. */
export interface CanvasPosition {
  readonly kind: "venture" | "project";
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface Milestone extends Recorded {
  readonly projectId: string;
  readonly stateId: string | null;
  readonly name: string;
  /** A date being aimed at. Soft: nothing compares it with today. */
  readonly aimingOn: DateOnly | null;
  readonly position: number;
}

export interface ChecklistItem {
  readonly text: string;
  readonly done: boolean;
}

/** A title and a venture. Everything else is optional, forever. */
export interface Task extends Recorded {
  readonly ventureId: string;
  readonly projectId: string | null;
  readonly milestoneId: string | null;
  readonly stateId: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly checklist: readonly ChecklistItem[];
  readonly priority: Priority | null;
  readonly dueOn: DateOnly | null;
  /** The day it was picked for today. Picking is daily, so yesterday's pick has lapsed. */
  readonly pickedOn: DateOnly | null;
  /** The order of the board column this task is in. */
  readonly position: number;
  /**
   * The order of the picked list on today, decision 23.
   *
   * Its own number because `position` orders a board column and the picked list crosses
   * columns, states and ventures. Null until the list is reordered by hand, and a task
   * without one falls in behind those that have one.
   */
  readonly todayPosition: number | null;
  /**
   * When to remind, a local wall time `YYYY-MM-DDTHH:MM` with no zone. The reminders phase
   * reads it in the account's zone. Null for no reminder.
   */
  readonly remindAt: string | null;
  /** `day`, `weekday`, `month` or `week:N` (Monday is 1), see `repeat.ts`. Null for never. */
  readonly repeat: string | null;
}

/** A property of a task, not a state. A task in any state may carry one. */
export interface Blocker extends Recorded {
  readonly taskId: string;
  readonly reason: string;
  readonly waitsOnTaskId: string | null;
  readonly person: string | null;
  readonly sinceOn: DateOnly | null;
}

/** Short and attached to exactly one of a venture or a project. */
export interface Note extends Recorded {
  readonly ventureId: string | null;
  readonly projectId: string | null;
  readonly body: string;
}

/** Something settled. No status: it is recorded, not worked. Attached to a venture or a project. */
export interface Decision extends Recorded {
  readonly ventureId: string | null;
  readonly projectId: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly decidedOn: DateOnly | null;
  readonly position: number;
}

/** Something watched. No status: it is recorded, not worked. Attached to a venture or a project. */
export interface Risk extends Recorded {
  readonly ventureId: string | null;
  readonly projectId: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly raisedOn: DateOnly | null;
  readonly position: number;
}

/** A link attaches to exactly one of a venture, a project or a task. */
export interface Link extends Recorded {
  readonly ventureId: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly url: string;
  readonly label: string | null;
  readonly role: LinkRole;
}

/**
 * A cross-cutting label a task or a project can carry. Never a venture.
 *
 * A name and nothing else. There is no colour here and there will not be one: colour in
 * this application carries state, and a label that picks its own colour takes that meaning
 * away from the one thing that has it. Two tags are told apart by their words.
 */
export interface Tag extends Recorded {
  readonly name: string;
}

/** Every kind the API creates, reads, updates and archives, by its path segment. */
export interface Records {
  readonly ventures: Venture;
  readonly states: State;
  readonly stages: Stage;
  readonly projects: Project;
  readonly milestones: Milestone;
  readonly tasks: Task;
  readonly blockers: Blocker;
  readonly notes: Note;
  readonly decisions: Decision;
  readonly risks: Risk;
  readonly links: Link;
  readonly tags: Tag;
}
export type Kind = keyof Records;

export const KINDS = [
  "ventures", "states", "stages", "projects", "milestones",
  "tasks", "blockers", "notes", "decisions", "risks", "links", "tags",
] as const satisfies readonly Kind[];

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export interface NextMilestone {
  readonly id: string;
  readonly name: string;
  readonly aimingOn: DateOnly | null;
}

/** The four figures the overview shows per venture. */
export interface Figures {
  readonly underway: number;
  readonly blocked: number;
  readonly tasksLeft: number;
  readonly nextMilestone: NextMilestone | null;
}

export interface OverviewVenture {
  readonly id: string;
  readonly name: string;
  readonly icon: IconName | null;
  readonly description: string | null;
  readonly parentId: string | null;
  readonly position: number;
  /** This venture's own work. */
  readonly own: Figures;
  /** Its own work and everything beneath it. The same as `own` for a venture with no children. */
  readonly total: Figures;
}

export interface Overview {
  readonly ventures: readonly OverviewVenture[];
  /** Every archived venture the account holds, top-level or nested, visible or not. */
  readonly archivedVentures: number;
}

export interface TaskWithBlocker extends Task {
  readonly blocker: Blocker | null;
  /**
   * The tags on this task, by id, ordered by tag name.
   *
   * Here and not on `Task` for the same reason `blocker` is: it is carried only where the
   * query supplies it. A single row fetched by id has no join to read, and a field that
   * answered `[]` there would be a lie the client could act on.
   */
  readonly tagIds: readonly string[];
}

export interface TreeMilestone extends Milestone {
  readonly blocked: boolean;
}

export interface TreeProject extends Project {
  /** Something in this project is blocked. Computed, never stored. */
  readonly blocked: boolean;
  /** The tags on this project, by id, ordered by tag name. Carried only where the query supplies it. */
  readonly tagIds: readonly string[];
  readonly milestones: readonly TreeMilestone[];
  readonly tasks: readonly TaskWithBlocker[];
}

export interface TreeVenture extends Venture {
  /** Something at or beneath this venture is blocked, children included. */
  readonly blocked: boolean;
  readonly states: readonly State[];
  readonly stages: readonly Stage[];
  readonly projects: readonly TreeProject[];
  /** Tasks that belong to the venture and to no project. */
  readonly tasks: readonly TaskWithBlocker[];
}

export interface Tree {
  readonly ventures: readonly TreeVenture[];
}

export interface TodayTask extends TaskWithBlocker {
  readonly stateKind: StateKind | null;
  readonly picked: boolean;
  /** An explicit due date before today, on a task not finished. The only overdue there is. */
  readonly overdue: boolean;
}

export interface Today {
  readonly on: DateOnly;
  readonly tasks: readonly TodayTask[];
}

/**
 * The two search filters that need a day. The Worker works both out against `on`, so no
 * client compares a due date: `before` is what was due before `on` and is not finished (the
 * Overdue card), `week` is what is due from `on` to the coming Sunday and is not finished (the
 * Due this week card). Archived tasks are in neither.
 */
export interface DateFilters {
  readonly on: DateOnly;
  readonly before: readonly Task[];
  readonly week: readonly Task[];
}

/** Every kind search finds, in the order its results are listed. */
export const SEARCH_KINDS = ["venture", "project", "milestone", "task", "decision", "risk", "note", "link"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/**
 * The most hits of each kind one search returns. Each kind has its own allowance, so fifty
 * task titles that share a word can never push the venture of that name out of the list.
 * A fixed rule, the same for every search: nothing here scores or ranks the work.
 */
export const SEARCH_MOST: Readonly<Record<SearchKind, number>> = {
  venture: 10, project: 15, milestone: 10, task: 40, decision: 10, risk: 10, note: 10, link: 10,
};

export interface SearchHit {
  readonly kind: SearchKind;
  readonly id: string;
  readonly ventureId: string;
  /** The project it sits on, if any: where a milestone, decision, risk, note or link opens. */
  readonly projectId: string | null;
  /** The task a note or a link sits on, which is where it opens. */
  readonly taskId: string | null;
  /** A task's title, a note's body cut as the archive cuts it, a link's label or address: what is listed. */
  readonly text: string;
}

/**
 * What a delete would remove, the record itself included. Decision 33.
 *
 * Counted from the database rather than guessed, because the fault this rework exists to fix
 * is people not knowing what a control will do — and this is the one control that cannot be
 * undone.
 */
export interface Removal {
  readonly ventures: number;
  readonly states: number;
  readonly stages: number;
  readonly projects: number;
  readonly milestones: number;
  readonly tasks: number;
  readonly blockers: number;
  readonly notes: number;
  readonly decisions: number;
  readonly risks: number;
  readonly links: number;
  readonly tags: number;
  /** Assignments, not records: a tag taken off a task, or a task taken away from its tags. */
  readonly taskTags: number;
  readonly projectTags: number;
}

export interface DeletePreview {
  readonly kind: Kind;
  readonly id: string;
  readonly label: string;
  /**
   * What has to be typed to delete it: the record's own name, or `delete` for a kind that
   * has no name — a blocker, a note, a task link or a link between ventures, whose label is
   * prose or a URL.
   */
  readonly confirm: string;
  readonly removes: Removal;
  /** Why it cannot be deleted right now, or null when it can. */
  readonly refusal: string | null;
}

export interface ArchivedItem {
  readonly kind: Kind;
  readonly id: string;
  readonly label: string;
  readonly archivedAt: string;
  /** An archived project's child project ids, so a restore can say what it waits on. */
  readonly holds?: readonly string[];
}

/** What the live channel says after a write. It names what changed and carries no record. */
export interface Change {
  readonly kind: Kind;
  readonly id: string;
  readonly ventureId: string | null;
  /** Set when a connected app made the write, so a screen that lists such writes knows to read them again. */
  readonly via?: "connector";
}
