/**
 * The data-access layer. The only file in the tree that knows the database is D1.
 *
 * Every statement lives here and nothing else holds the binding: routes get a `Store` of
 * plain methods over plain objects. D1 and Workers are proprietary, and if this is ever
 * moved the exit is this file rather than the application. `tests/d1-one-file.test.ts`
 * fails the build if a second source file learns the binding.
 *
 * A Worker reaches D1 over the network, so a round trip is the unit of cost. Each read
 * path is one call — one statement, or one `batch`, which D1 sends and runs as a single
 * transaction. Writes are a read of the current row and one batch.
 *
 * Rules that span rows — how deep ventures nest, that a milestone belongs to its task's
 * project — are the WHERE clause of the statement that writes the row, so there is no gap
 * between checking and writing. When a write changes nothing, the same rules are asked
 * again one by one to say which refused.
 *
 * Archiving is the reachable, undoable act, and it destroys nothing: a row is visible while
 * it and every container above it are unarchived; archiving a container stamps the container
 * and nothing inside it. The one exception is a milestone, which is a checkpoint rather than
 * a container: archiving it lets go of its tasks, so they stay in view in their project.
 *
 * Deleting is the second, deliberate act, and it is the only thing here that destroys a row.
 * Decision 33: it is offered only on something already archived, it names what goes with it
 * first, and it cannot be undone. `deletePreview` counts with SELECTs and `remove` performs:
 * `remove` is the only statement here that destroys a record. `DELETE FROM` appears in other
 * places, none of them a record. `tagStatements` replaces a record's tag assignments,
 * and an assignment is an edge between two rows that both survive it. `putEmailToken`,
 * `takeEmailToken`, `acceptInvite` and `withdrawInvite` sweep, spend and withdraw mailed
 * links, which are short-lived single-use tokens, not anything anybody made, and replace an
 * invitation sent again to the same address.
 * `putInvite`, `withdrawPersonInvite` and `acceptPersonInvite` keep, archive and use the owner's
 * invitations by first name; they are archived or marked used, never removed.
 * `restoreAll` clears the owner's rows and writes a file's in their place, in one batch, only
 * after the route has had the word that confirms it; `purgeAccounts` removes the accounts whose
 * seven days after asking have passed, with every row they own. Neither is reachable from a record.
 * `attempt` sweeps old rows of `throttle` and `forgetAttempts` clears a key's, or gives back an
 * attempt that turned out good: a throttle row is a counted attempt, not anything anybody made.
 */
import {
  DEFAULT_APPEARANCE, DEFAULT_NEW_STAGES, ENCRYPTED_FIELDS, EXTRA_SWITCHES, isAccent, isEnvelopeShape, isMapStyle, isSealed, isSpacing, isThemeMode, nextDue,
  parseRepeat, SEARCH_KINDS, SEARCH_MOST, STAGE_KINDS, START_SCREENS, VENTURE_VIEWS, type AccountLevelNames, type Appearance,
  type EncryptedKind, type ExtraSwitches, type StartScreen, type VentureView,
} from "@vemi/shared";
import type {
  ArchivedItem,
  CanvasPosition,
  DeletePreview,
  Blocker,
  ChecklistItem,
  ExportDocument,
  Figures,
  Kind,
  Link,
  LinkRole,
  Milestone,
  NextMilestone,
  Note,
  Decision,
  Risk,
  Overview,
  OverviewVenture,
  Priority,
  Project,
  Records,
  Removal,
  SearchHit,
  SearchKind,
  State,
  Stage,
  StageKind,
  StateKind,
  Tag,
  Task,
  TaskWithBlocker,
  DateFilters,
  Today,
  TodayTask,
  Tree,
  TreeProject,
  TreeVenture,
  Venture,
} from "@vemi/shared";
import type { SqlBinding } from "../local/sqlD1.js";

/** The part of the Worker's environment the store reads. Nothing else reads it. */
export interface StoreEnv {
  readonly DB: D1Database;
}

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: 400 | 404 | 409; readonly error: string };

/** A record as written, and the venture it sits in, for the live channel. */
export interface Written<T> {
  readonly record: T;
  readonly ventureId: string | null;
  /** The create had been made before under the same id, and this is that record, unchanged. */
  readonly replayed?: boolean;
  /** Finishing a repeating task made this one, the next of its kind, in the same call. */
  readonly spawned?: Records["tasks"];
}

/** What finishing a repeating task files next: the fields that carry over from the old task, and its due date. */
interface NextTask {
  readonly sourceId: string;
  readonly ventureId: string;
  readonly projectId: string | null;
  readonly milestoneId: string | null;
  readonly stateId: string | null;
  readonly title: string;
  readonly priority: string | null;
  readonly dueOn: string;
  readonly remindAt: string | null;
  readonly repeat: string | null;
}

/**
 * An id a client chose for the thing it is creating. A client that queues writes while
 * offline may send the same create twice, and the id is what makes the second one land on
 * the first rather than beside it.
 */
export interface ClientId {
  readonly id?: string;
}

export interface CreateInput {
  readonly ventures: {
    name: string; icon?: string | null; description?: string | null; parentId?: string | null; position?: number;
  };
  readonly states: { ventureId: string; name: string; kind: StateKind; position?: number };
  readonly stages: { ventureId: string; name: string; kind: StageKind; position?: number };
  readonly projects: {
    ventureId: string; name: string; icon?: string | null; description?: string | null; position?: number;
    tagIds?: readonly string[]; parentId?: string | null;
    whoFor?: string | null; doneLooks?: string | null; openQuestions?: string | null;
  };
  readonly milestones: {
    projectId: string; name: string; stateId?: string | null; aimingOn?: string | null; position?: number;
  };
  readonly tasks: {
    ventureId: string; title: string; projectId?: string | null; milestoneId?: string | null;
    stateId?: string | null; body?: string | null; checklist?: readonly ChecklistItem[];
    priority?: Priority | null; dueOn?: string | null; pickedOn?: string | null;
    position?: number; todayPosition?: number | null;
    remindAt?: string | null; repeat?: string | null;
    /**
     * The tags this task carries, whole. Written the way the checklist is: the list given
     * replaces the list held, an empty one clears it, and leaving the key out changes
     * nothing. There is no endpoint of its own — an assignment is part of the task.
     */
    tagIds?: readonly string[];
  };
  readonly blockers: {
    taskId: string; reason: string; waitsOnTaskId?: string | null; person?: string | null; sinceOn?: string | null;
  };
  readonly notes: {
    ventureId?: string | null; projectId?: string | null;
    body: string;
  };
  readonly decisions: {
    ventureId?: string | null; projectId?: string | null; title: string; body?: string | null;
    decidedOn?: string | null; position?: number;
  };
  readonly risks: {
    ventureId?: string | null; projectId?: string | null; title: string; body?: string | null;
    raisedOn?: string | null; position?: number;
  };
  readonly links: {
    ventureId?: string | null; projectId?: string | null; taskId?: string | null;
    url: string; label?: string | null; role?: LinkRole;
  };
  readonly tags: { name: string };
}

/** A venture or project is set at a lifecycle stage, and marked at risk, by a patch and never at creation. */
interface Placed {
  readonly stageId?: string | null;
  readonly atRisk?: boolean;
}

/** What each kind lets a patch change. A key present means "set it", null included. */
export interface PatchInput {
  readonly ventures: Partial<Pick<CreateInput["ventures"],
    "name" | "icon" | "description" | "parentId" | "position">> & Placed
    & { readonly views?: readonly VentureView[]; readonly monogram?: string | null };
  readonly states: Partial<Pick<CreateInput["states"], "name" | "kind" | "position">>;
  readonly stages: Partial<Pick<CreateInput["stages"], "name" | "kind" | "position">>;
  readonly projects: Partial<Pick<CreateInput["projects"],
    "ventureId" | "name" | "icon" | "description" | "position" | "tagIds" | "parentId" | "whoFor" | "doneLooks" | "openQuestions">> & Placed & { readonly pinnedAt?: string | null };
  readonly milestones: Partial<Pick<CreateInput["milestones"], "name" | "stateId" | "aimingOn" | "position">>;
  readonly tasks: Partial<CreateInput["tasks"]>;
  readonly blockers: Partial<Omit<CreateInput["blockers"], "taskId">>;
  readonly notes: Partial<Pick<CreateInput["notes"], "body">>;
  readonly decisions: Partial<Pick<CreateInput["decisions"], "title" | "body" | "decidedOn" | "position">>;
  readonly risks: Partial<Pick<CreateInput["risks"], "title" | "body" | "raisedOn" | "position">>;
  readonly links: Partial<Pick<CreateInput["links"], "url" | "label" | "role">>;
  readonly tags: Partial<CreateInput["tags"]>;
}

/** What a signed-in person may be shown of their own account. Never a secret. */
export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly confirmed: boolean;
  readonly hasPassword: boolean;
  readonly google: boolean;
}

/** An account with the parts that prove who it is. Stays inside the Worker. */
export interface AccountSecret extends AccountView {
  readonly passwordHash: string | null;
  readonly googleSub: string | null;
  /** Bumped to end every session at once; a session carries the number it was issued at. */
  readonly generation: number;
  /** The authenticator key, sealed by the identity. Set during setup; null when 2-step was never begun or is off. */
  readonly twoStepSecret: string | null;
  /** When 2-step went on. Null while it is off or only half set up. */
  readonly twoStepOnAt: string | null;
  /** The last 30 second step of an authenticator code that signed this account in; null before the first. */
  readonly totpLastStep: number | null;
  /** SHA-256 hashes of the backup codes still unused. */
  readonly backupCodes: readonly string[];
  /** When the account is due to be removed, or null when no one has asked. */
  readonly deleteOn: string | null;
  /** The name the owner invited them as; null for an account that was not invited by name. */
  readonly firstName: string | null;
}

/** What 2-step holds for an account; all empty means off. */
export interface TwoStepState {
  readonly secret: string | null;
  readonly on: boolean;
  readonly backupCodes: readonly string[];
}

/** The email is stored as given here, so the caller lowercases and trims it first. */
export interface NewAccount {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly googleSub: string | null;
  readonly confirmed: boolean;
}

export type TokenPurpose = "invite" | "confirm" | "reset";

/** One invitation by first name, waiting. `id` is the hash of its link, which is not the link. */
export interface PersonInvite {
  readonly id: string;
  readonly firstName: string;
  readonly expiresAt: string;
}

/** An account made from one of the owner's invitations. */
export interface Person {
  readonly id: string;
  readonly firstName: string | null;
  readonly email: string;
  readonly deleteOn: string | null;
}

/** What the owner sees under People: who joined, and the links still waiting. */
export interface People {
  readonly people: Person[];
  readonly invites: PersonInvite[];
}

/** The address a move code's `confirm` row carries: not an address, so no mailed link can be mistaken for it. */
export const MOVE_CODE_MARK = "move code";

/** The id is the SHA-256 of the token that was mailed, never the token itself. */
export interface EmailToken {
  readonly id: string;
  readonly owner: string;
  readonly purpose: TokenPurpose;
  readonly email: string;
  readonly expiresAt: string;
}

/** A session is open, ended on purpose (its generation moved on), or its account is gone. */
export type SessionState = "open" | "ended" | "gone";

/** A store whose first round trip also reads whether a session still stands. */
export interface SessionRead {
  readonly store: Store;
  holds(): Promise<SessionState>;
}

/** What a notification can do to a task. */
export type ReminderAction = "done" | "snooze";

/** A time a number of days after (or before, when negative) `from`, as the ISO text the tables keep. */
const daysFrom = (from: Date, days: number): string => new Date(from.getTime() + days * 86_400_000).toISOString();

/** A connector refresh token lives this long from the last rotation. */
const REFRESH_DAYS = 30;
/** A revoked grant is kept this long before the daily purge removes it. */
const REVOKED_KEPT_DAYS = 30;

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** True for a local wall time as `YYYY-MM-DDTHH:MM` that is a real date and clock. */
export function isWallTime(at: string): boolean {
  const m = WALL_TIME.exec(at);
  if (m === null) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return date.toISOString().slice(0, 16) === at;
}

/** The wall time an hour on from `at`, by calendar arithmetic with no zone in it. */
function oneHourOn(at: string): string {
  const [y, mo, d, h, mi] = (WALL_TIME.exec(at) ?? []).slice(1).map(Number) as [number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h + 1, mi)).toISOString().slice(0, 16);
}

/** A throttle key, a SHA-256 the caller makes, and how many rows it may hold in a window. */
export interface AttemptLimit {
  readonly key: string;
  readonly limit: number;
}

export interface Store {
  overview(owner: string): Promise<Overview>;
  tree(owner: string): Promise<Tree>;
  /** `on` is the local date that counts as today, `YYYY-MM-DD`. */
  today(owner: string, on: string): Promise<Today>;
  /** The two date search filters, against the same `on` as `today`. */
  dateFilters(owner: string, on: string): Promise<DateFilters>;
  search(owner: string, q: string): Promise<SearchHit[]>;
  archived(owner: string): Promise<ArchivedItem[]>;
  /** Every live sealed field of this owner, as stored: the envelope and where it sits. For a device to search. */
  locked(owner: string): Promise<LockedField[]>;

  list<K extends Kind>(owner: string, kind: K, filter: Readonly<Record<string, string>>): Promise<Outcome<Records[K][]>>;
  /** Archived or not, so that an archived thing can be found and restored. */
  get<K extends Kind>(owner: string, kind: K, id: string): Promise<Records[K] | null>;
  /** Given an id already used for this owner and kind, answers with that record instead of a second one. */
  create<K extends Kind>(owner: string, kind: K, input: CreateInput[K] & ClientId): Promise<Outcome<Written<Records[K]>>>;
  /**
   * `today` is the local date that counts as today, `YYYY-MM-DD`; finishing a repeating task files
   * the next one after it. Left out, it is the date in UTC.
   */
  update<K extends Kind>(owner: string, kind: K, id: string, patch: PatchInput[K], today?: string): Promise<Outcome<Written<Records[K]>>>;
  setArchived<K extends Kind>(owner: string, kind: K, id: string, archived: boolean): Promise<Outcome<Written<Records[K]>>>;
  /**
   * What a notification's buttons do to a due task. "done" moves it to its space's finished
   * state through `update`, so a repeating task spawns its next; "snooze" moves `remindAt` an
   * hour on from `at`, by wall-clock arithmetic. A task that is not this account's, or is
   * archived, is 404.
   */
  actOnReminder(owner: string, taskId: string, action: ReminderAction, at: string, today?: string): Promise<Outcome<Written<Task>>>;
  /** What deleting this would destroy, and why it cannot be. Null when there is no such record. */
  deletePreview(owner: string, kind: Kind, id: string): Promise<DeletePreview | null>;
  /** Decision 33. Destroys the record and its cascade. Nothing here can be undone. */
  remove(owner: string, kind: Kind, id: string, confirm: string): Promise<Outcome<{ removes: Removal; ventureId: string | null }>>;

  /**
   * One round trip for a throttled attempt, counted before the work it guards. Sweeps rows
   * older than `sweepBefore`, then records one row at `at` for every key, unless any key
   * already has `limit` rows at or after `since`, in which case it records none. One
   * statement checks and records, so attempts sent together cannot all pass a count made
   * before any of them was recorded. `reserved` is the rows recorded, for `forgetAttempts` to
   * give back when the attempt turns out good, or null when a limit was reached. With an
   * address, also answers the account at it.
   */
  attempt(email: string | null, limits: readonly AttemptLimit[], at: string, since: string, sweepBefore: string): Promise<{
    account: AccountSecret | null;
    reserved: readonly number[] | null;
  }>;
  /** Clears every row these keys have, and the `reserved` rows `attempt` answered. */
  forgetAttempts(keys: readonly string[], reserved?: readonly number[]): Promise<void>;
  account(owner: string): Promise<AccountSecret | null>;
  /** The account's look and capture settings. The shipped defaults when the owner has no account row. */
  appearance(owner: string): Promise<AccountSettings>;
  /** Where the account is in the first steps and which tips it has seen. Nothing on, with no account row. */
  firstRun(owner: string): Promise<FirstRun>;
  /** Moves the step (null ends the steps) or records one tip as seen. 404 with no such account. */
  setFirstRun(owner: string, change: FirstRunChange): Promise<Outcome<FirstRun>>;

  /** This owner's live key rows. Ciphertext and public references only; nothing the server could open. */
  keys(owner: string): Promise<KeySet>;
  /** Adds rows in one batch. 409 when live rows already carry another key ref, or a row id is taken. */
  addKeys(owner: string, bundle: KeyBundle): Promise<Outcome<KeySet>>;
  /** Archives one live row and, for a device row, the passkey rows made on it. 404 when it is not this owner's. */
  archiveKey(owner: string, id: string): Promise<Outcome<{ readonly archived: number }>>;
  /** Archives the live recovery row and adds the new one in one batch. 409 when there is no key. */
  replaceRecovery(owner: string, wrap: KeyWrapInput): Promise<Outcome<KeySet>>;
  /** Archives every live row and adds a new key's rows in one batch. */
  startAgain(owner: string, bundle: KeyBundle): Promise<Outcome<KeySet>>;
  /** Opens a pairing for ten minutes. 409 when the id is taken. */
  openPairing(owner: string, id: string): Promise<Outcome<{ readonly id: string; readonly expiresAt: string }>>;
  /** Fills an open, unexpired, unfilled pairing once. 404 when none is open, 409 when it is filled. */
  fillPairing(owner: string, id: string, parts: { readonly sealed: string }): Promise<Outcome<{ readonly filled: true }>>;
  /** Waiting, or the filled parts, which archives the pairing so a second read finds nothing. */
  readPairing(owner: string, id: string): Promise<Outcome<PairingRead>>;
  /**
   * Changes the named settings and answers all of them. 404 with no such account, or with a
   * `newTaskVentureId` that is not a space this owner has.
   */
  setAppearance(owner: string, change: AccountSettingsChange): Promise<Outcome<AccountSettings>>;
  /** Where the account is in full encryption, and how many typed cells wait to be sealed and how many are sealed. */
  encryption(owner: string): Promise<EncryptionReport>;
  /** Starts turning encryption on or off. 409 when already in that state or the other is running. */
  startEncryption(owner: string, to: "on" | "off"): Promise<Outcome<EncryptionReport>>;
  /**
   * Writes at most `SEAL_BATCH_MOST` records' typed cells in one batch. 404 when a record is not this
   * owner's; 409 when no run is going, or a cell is plain while turning on or sealed while turning off.
   */
  sealBatch(owner: string, records: readonly SealRecord[]): Promise<Outcome<{ readonly written: number }>>;
  /** Flips to `on` or `off` only when none remain; otherwise 409. */
  finishEncryption(owner: string): Promise<Outcome<EncryptionReport>>;
  /**
   * Keeps this device's subscription for the account. The endpoint is the device's own, so a
   * second account turning reminders on from the same browser takes it over; an archived one
   * comes back.
   */
  subscribePush(owner: string, sub: NewPushSubscription): Promise<PushSubscriptionSummary>;
  /** Archives this account's subscription to that endpoint. False when it has none. */
  unsubscribePush(owner: string, endpoint: string): Promise<boolean>;
  /** This account's live subscriptions, oldest first, without their keys. */
  pushSubscriptions(owner: string): Promise<PushSubscriptionSummary[]>;
  /** This account's saved filters, in the order they were saved. */
  filters(owner: string): Promise<SavedFilter[]>;
  /** Saves a filter. 409 when the account already has `FILTERS_MOST`. */
  createFilter(owner: string, input: NewSavedFilter): Promise<Outcome<SavedFilter>>;
  /** Renames one of this account's filters. 404 when it is not theirs. */
  renameFilter(owner: string, id: string, name: string): Promise<Outcome<SavedFilter>>;
  /** Archives one of this account's filters, and nothing else. False when it is not theirs. */
  removeFilter(owner: string, id: string): Promise<boolean>;
  /**
   * The connector keeps only hashes: the caller hashes a code or a token before it comes
   * here, and nothing here can give the secret back. Registering an app again replaces its name and addresses.
   */
  registerClient(client: ConnectorClient): Promise<void>;
  client(id: string): Promise<ConnectorClient | null>;
  /** Keeps a code for this account's Allow. */
  putCode(owner: string, code: NewConnectorCode): Promise<void>;
  /** Single use: spent whether or not it had expired, and answered only when it had not. Names the account that allowed it. */
  takeCode(hash: string): Promise<ConnectorCode | null>;
  /** Opens a grant for this account and the app named, from the hashes of its two secrets. */
  issueGrant(owner: string, grant: NewConnectorTokens & { readonly clientId: string }): Promise<ConnectorGrant>;
  /**
   * The grant whose access token this is, when it is neither revoked nor expired, noting it as used now.
   * Not scoped to an owner, because the token is the proof; what it answers names the owner.
   */
  grantByToken(tokenHash: string): Promise<ConnectorGrant | null>;
  /**
   * Swaps both secrets of the grant this refresh token belongs to, and starts its 30 days
   * again. The old pair stops working. Null when revoked, unknown, past its 30 days, or
   * belonging to another app than `clientId`; in each of those nothing is changed.
   */
  rotateGrant(refreshHash: string, clientId: string, next: NewConnectorTokens): Promise<ConnectorGrant | null>;
  /** This account's grants that have not been revoked, oldest first. */
  grants(owner: string): Promise<ConnectorGrant[]>;
  /** Revokes one of this account's grants. False when it is not theirs or was already revoked. */
  revokeGrant(owner: string, id: string): Promise<boolean>;
  /**
   * For the daily job, across accounts: removes expired codes, grants whose refresh token has
   * run out or that were revoked more than `REVOKED_KEPT_DAYS` ago, and apps that asked more
   * than a day ago and hold no grant or code.
   */
  purgeConnector(): Promise<{ readonly codes: number; readonly grants: number; readonly clients: number }>;
  /** Keeps what an app just did, with the record's earlier values. */
  recordChange(owner: string, change: NewConnectorChange): Promise<ConnectorChange>;
  /** This account's changes made at or after `since`, newest first. */
  changes(owner: string, since: string): Promise<ConnectorChange[]>;
  /** One of this account's changes, whatever its age, or null when it is not theirs. */
  change(owner: string, id: string): Promise<ConnectorChange | null>;
  /** Marks one of this account's changes undone. False when it is not theirs or was already undone. */
  markChangeUndone(owner: string, id: string): Promise<boolean>;
  /**
   * Every account the tick may have to tell something: one with a live subscription and a
   * reminder setting on. Its zone is its newest subscription's. Read across owners; the one
   * place that does, for the tick.
   */
  reminderAccounts(): Promise<ReminderAccount[]>;
  /** The account's live subscriptions with the keys a message is encrypted to, oldest first. */
  pushDevices(owner: string): Promise<PushDevice[]>;
  /**
   * Tasks with a reminder set between `from` and `to` (local wall times, both inclusive),
   * not archived, not finished and not already sent for that exact `remind_at`. Oldest first.
   */
  dueReminders(owner: string, from: string, to: string, limit: number): Promise<DueReminder[]>;
  /** Whether a reminder of this kind has been sent for that ref and moment. */
  reminderWasSent(owner: string, kind: string, ref: string, at: string): Promise<boolean>;
  /** Records a send, so nothing goes twice. Safe to repeat. */
  recordReminderSent(owner: string, kind: string, ref: string, at: string): Promise<void>;
  /** Notes that a device took a message. */
  pushWorked(owner: string, deviceId: string): Promise<void>;
  /** The key pair this copy signs push messages with, or null before the first use. */
  vapidKey(): Promise<StoredVapidKey | null>;
  /** Keeps the pair unless one is already kept, and answers the one that is. Safe to race. */
  keepVapidKey(key: StoredVapidKey): Promise<StoredVapidKey>;
  /** The secret this copy signs sessions with when none is set as a secret, or null before the first use. */
  sessionKey(): Promise<string | null>;
  /** Keeps the secret unless one is already kept, and answers the one that is. Safe to race. */
  keepSessionKey(secret: string): Promise<string>;
  /** The one-time claim made by the setup page, or null while the copy is unclaimed. */
  setupClaim(): Promise<SetupClaim | null>;
  /** Keeps the claim unless one is already kept; `made` is true only for the call that kept it. Safe to race. */
  keepSetupClaim(sealedToken: string | null, keepUpdated: boolean): Promise<{ readonly claim: SetupClaim; readonly made: boolean }>;
  /** The last daily check, or null before the first. */
  updateCheck(): Promise<UpdateCheckRecord | null>;
  /**
   * Records a finished check now: keeps the offer, or clears it (archives it) when `offer` is null.
   * `issuedAt` is the signed issue date of the release just read; the newest one ever given is kept.
   */
  keepUpdateCheck(offer: UpdateOffer | null, issuedAt?: string | null): Promise<UpdateCheckRecord>;
  /** The update in progress or just done, or null when none was started. */
  updateRun(): Promise<UpdateRun | null>;
  /** Keeps the whole run row, replacing the one kept; `updatedAt` is set to now. */
  keepUpdateRun(run: Omit<UpdateRun, "updatedAt">): Promise<UpdateRun>;
  /**
   * Starts a run only when none is open: the row is empty, done, or untouched for a day. True for the one
   * call that started it, so two taps at once make one run.
   */
  openUpdateRun(run: Omit<UpdateRun, "updatedAt">): Promise<boolean>;
  /**
   * Takes the run's next step for one caller: true only when the run is at `step` and no other caller
   * holds it (a hold lapses after a minute). Safe to race. `keepUpdateRun` lets it go.
   */
  takeUpdateStep(step: string): Promise<boolean>;
  /** Makes the daily check due again at the next hour, so a release is offered again soon after a Go back. */
  expireUpdateCheck(): Promise<void>;
  /**
   * Deletes the copy's sealed key and the wish to keep updated (decision 14 Nov: the setup key is deleted
   * when self-update is off). The row itself stays, marked spent, so the setup code cannot claim the copy
   * again. True when a key or the wish was cleared.
   */
  removeSetupKey(): Promise<boolean>;
  /** Whether a signed-out visitor to the front address sees the landing page. On until the owner turns it off. */
  frontLanding(): Promise<boolean>;
  /** Turns the landing page on or off for the whole copy and answers the new state. */
  setFrontLanding(landing: boolean): Promise<boolean>;
  /** Where the account has put each box on its canvas. */
  canvas(owner: string): Promise<CanvasPosition[]>;
  /** Places or moves a batch of boxes and answers every position. 404 when one names a record the account does not own. */
  setCanvas(owner: string, positions: readonly CanvasPosition[]): Promise<Outcome<CanvasPosition[]>>;
  /** Accounts that hold this Google identity or this address: at most two. */
  accountsForGoogle(sub: string, email: string): Promise<AccountSecret[]>;
  /** Makes the tenant if needed, then the account. False when the address, the id or the Google identity is taken. */
  createAccount(account: NewAccount): Promise<boolean>;
  /** Sets the password, ends every session, and with `confirm` marks the address confirmed. Answers the new generation, or null with no such account. */
  setPassword(owner: string, passwordHash: string, confirm: boolean): Promise<number | null>;
  /** Ends every session. Answers the new generation, or null with no such account. */
  endSessions(owner: string): Promise<number | null>;
  /** Writes the account's 2-step state whole: begin (secret, off), turn on (with backup codes) or off (all empty). False with no such account. */
  setTwoStep(owner: string, state: TwoStepState): Promise<boolean>;
  /** Uses up one backup code by its hash. False when the account has no such code, or another request used it first. */
  spendBackupCode(owner: string, hash: string): Promise<boolean>;
  /** Records an authenticator code's time step as used. False when that step, or a later one, was already used, so a code cannot be replayed. */
  acceptTotpStep(owner: string, step: number): Promise<boolean>;
  /** Keeps this hash as the account's sign-in recovery code, replacing any earlier one. */
  setRecoveryCode(owner: string, hash: string): Promise<void>;
  /** Uses up the recovery code if the hash is it. False when it is not, or it was already used. */
  spendRecoveryCode(owner: string, hash: string): Promise<boolean>;
  /** False when the account is gone or this Google identity belongs to another. */
  linkGoogle(owner: string, sub: string): Promise<boolean>;
  /** False unless a password remains to sign in with. */
  unlinkGoogle(owner: string): Promise<boolean>;
  sessionHolds(owner: string, generation: number): Promise<SessionState>;
  /**
   * This store for one read, with `sessionHolds` riding along: the first round trip the read
   * makes carries the session's row ahead of its own statements, so an authenticated read is
   * one round trip rather than two. `holds` answers what `sessionHolds` would, and asks on
   * its own only when the read made no round trip at all. For reads alone: a write in the
   * same batch as the check would land before anything had said whether it may.
   */
  readingAs(owner: string, generation: number): SessionRead;
  /** Sweeps expired tokens. An invite replaces this owner's earlier invite to the same address. */
  putEmailToken(token: EmailToken): Promise<void>;
  /** Single use: spent whether or not it had expired, and only answered when the purpose matches and it has not expired. */
  takeEmailToken(id: string, purpose: TokenPurpose): Promise<EmailToken | null>;
  /** Invitations this owner sent that are still waiting and unexpired. */
  invites(owner: string): Promise<EmailToken[]>;
  /** The unexpired mailed link this token hash names, for this purpose, without spending it. */
  pendingToken(id: string, purpose: TokenPurpose): Promise<EmailToken | null>;
  /**
   * Makes the account an invitation offered, at the invited address and confirmed, and spends
   * the invitation, in one transaction. An account refused because the address, the id or the
   * Google identity is taken leaves the invitation as it was, to be used another way.
   * `invalid` when no unexpired invitation has this hash; an expired one is spent all the same.
   */
  acceptInvite(id: string, account: Pick<NewAccount, "id" | "passwordHash" | "googleSub">): Promise<
    { readonly made: true; readonly email: string } | { readonly made: false; readonly why: "invalid" | "taken" }
  >;
  /** Withdraws this owner's waiting invitation to this address. False when there was none. */
  withdrawInvite(owner: string, email: string): Promise<boolean>;
  /** Keeps an invitation by first name. `id` is the SHA-256 of the link's token; it works once, until `expiresAt`. */
  putInvite(invite: { readonly id: string; readonly owner: string; readonly firstName: string; readonly expiresAt: string }): Promise<void>;
  /** The people this owner invited who joined, and the invitations still waiting. */
  people(owner: string): Promise<People>;
  /** Withdraws this owner's waiting invitation by its id. It is archived, not deleted. False when there was none. */
  withdrawPersonInvite(owner: string, id: string): Promise<boolean>;
  /** Asks for one of this owner's people to go in seven days, as they could ask themselves. 404 when they are not this owner's. */
  removePerson(owner: string, id: string): Promise<Outcome<{ readonly deleteOn: string }>>;
  /** The first name on an unused, unexpired invitation by this hash, without spending it. */
  pendingPersonInvite(id: string): Promise<{ readonly firstName: string } | null>;
  /**
   * Makes the account an invitation by name offered, at the address given and confirmed, with the
   * invited first name, and marks the invitation used, in one transaction. Refused leaves it as it
   * was. `invalid` when no unused, unexpired invitation has this hash.
   */
  acceptPersonInvite(id: string, account: Pick<NewAccount, "id" | "email" | "passwordHash" | "googleSub">): Promise<
    { readonly made: true } | { readonly made: false; readonly why: "invalid" | "taken" }
  >;

  /** Every table this owner has rows in, minus `EXPORT_EXCLUDED`, as one JSON document. */
  exportAll(owner: string, now: Date): Promise<ExportDocument>;
  /**
   * Replaces this owner's data with a file's rows, every id made new and every reference
   * following it, in one batch: all of it lands or none. The file's settings, when it has
   * them, replace the account's. 400 when the file does not fit this copy.
   */
  restoreAll(owner: string, file: RestoreFile): Promise<Outcome<{
    readonly counts: Record<string, number>;
    readonly locked: RestoredLock[];
    /** Every row's id in the file, to the id it was given here. */
    readonly ids: Record<string, string>;
  }>>;
  /**
   * What `restoreAll` would refuse, with nothing written. The counts are the file's. With no
   * owner nothing is read for one; with an owner the refusals that depend on the account
   * (full encryption) apply too.
   */
  checkRestore(file: RestoreFile, owner?: string): Promise<Outcome<{ readonly counts: Record<string, number> }>>;
  /** When this account is due to be removed, or null when no one has asked. */
  deletion(owner: string): Promise<string | null>;
  /** Asks for the account to go in seven days. Asking again keeps the first date. 404 with no such account. */
  scheduleDeletion(owner: string): Promise<Outcome<{ readonly deleteOn: string }>>;
  /** Takes the request back. False when there was none. */
  cancelDeletion(owner: string): Promise<boolean>;
  /** Removes every account whose time has come, with all its rows, except `keep`. Answers how many went. */
  purgeAccounts(keep: string): Promise<number>;
}

/** One sealed field of one live record, as stored. `value` is the envelope. */
export interface LockedField {
  readonly kind: "projects" | "tasks" | "notes";
  readonly id: string;
  readonly field: string;
  readonly value: string;
  readonly ventureId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
}

/**
 * A sealed field a restore brought back under a new id. It is still bound to `from`, so the
 * device holding the file's key reseals it to `to` and saves it.
 */
export interface RestoredLock {
  readonly kind: "projects" | "tasks" | "notes";
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

/** Where an account is in sealing its typed text. The server holds envelopes only while `on`. */
export type EncryptionState = "off" | "turning_on" | "on" | "turning_off";

/** The state, and how many typed cells are still plain and how many are sealed by full encryption. */
export interface EncryptionReport {
  readonly state: EncryptionState;
  readonly unsealed: number;
  readonly sealed: number;
}

/** What a batch may seal: any typed kind, `settings` with the account's id, or a connector change's `before`. */
export type SealKind = EncryptedKind | "connector_change";

/** One record's typed cells for a batch. A checklist is the whole list with each item's `text` as it should be stored. */
export interface SealRecord {
  readonly kind: SealKind;
  readonly id: string;
  readonly fields: Readonly<Record<string, string | readonly ChecklistItem[]>>;
}

/** Most records one batch may write. */
export const SEAL_BATCH_MOST = 50;

/** The most text one write statement carries, so a batch of large bodies is several statements and no bound value is large. */
const SEAL_SLICE_CHARS = 400_000;

/** What a write is told when the account is fully encrypted and the text sent is plain. */
export const SEALED_ONLY = "This VEMI is fully encrypted. Update VEMI and try again.";

/** A file read for a restore: the rows by table, and the settings of a version 2 file. */
export interface RestoreFile {
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly settings?: AccountSettingsChange;
}

/** Every venture starts with these, and the user renames them. */
export const DEFAULT_STATES: readonly { readonly name: string; readonly kind: StateKind }[] = [
  { name: "to do", kind: "not_started" },
  { name: "doing", kind: "underway" },
  { name: "done", kind: "finished" },
];

/** The ten stages migration 0008 gave the spaces that existed then. A new space starts with the account's own, else `DEFAULT_NEW_STAGES`. */
export const DEFAULT_STAGES: readonly { readonly name: string; readonly kind: StageKind }[] = [
  { name: "Concept", kind: "early" },
  { name: "Pre-Production", kind: "early" },
  { name: "Production", kind: "active" },
  { name: "Alpha", kind: "active" },
  { name: "Beta", kind: "active" },
  { name: "Certification", kind: "active" },
  { name: "Launched", kind: "shipped" },
  { name: "Live Ops", kind: "shipped" },
  { name: "On Hold", kind: "paused" },
  { name: "Cancelled", kind: "stopped" },
];

export function openStore(env: StoreEnv, clock: () => Date = () => new Date()): Store {
  return new D1Store(env.DB, clock);
}

/** The store over the on-device stand-in. The one cast: the stand-in has the binding's shape, not its type. */
export function openLocalStore(binding: SqlBinding, clock: () => Date = () => new Date()): Store {
  return new D1Store(binding as unknown as D1Database, clock);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const TABLE: Readonly<Record<Kind, string>> = {
  ventures: "venture",
  states: "state",
  stages: "stage",
  projects: "project",
  milestones: "milestone",
  tasks: "task",
  blockers: "blocker",
  notes: "note",
  decisions: "decision",
  risks: "risk",
  links: "link",
  tags: "tag",
};

/**
 * The two tables that hold rows rather than records: a tag put on a task, and a tag put on
 * a project. They are edges, so they have no route, no archive and no delete of their own —
 * but a delete still has to count them and take them with it, which is what these names are
 * for. `Removal` carries one number per key.
 */
const EDGE_TABLE = { taskTags: "task_tag", projectTags: "project_tag" } as const;
/** The column in each edge that names the thing the tag was put on. */
const EDGE_COLUMN = { taskTags: "task_id", projectTags: "project_id" } as const;
type Edge = keyof typeof EDGE_TABLE;
const EDGES = Object.keys(EDGE_TABLE) as Edge[];
const tableOf = (k: Kind | Edge): string => (k in EDGE_TABLE ? EDGE_TABLE[k as Edge] : TABLE[k as Kind]);

/**
 * Tables with an `owner` column that `exportAll` never includes, because they hold no
 * record a person made: `credential` and `recovery_code` are sign-in secrets, `challenge`
 * is a short-lived sign-in token, `email_token` is a mailed link, and `backup_run` is the
 * app's own operational log.
 */
/**
 * Rows a kept table still holds that the export leaves out. A task or milestone note was cut
 * (VEMI-013 trim) and its text now lives in the task body or a project note, so only notes on
 * a venture or a project are exported. The old rows stay in the table.
 */
const EXPORT_ROW_FILTER: Readonly<Record<string, string>> = {
  note: " AND task_id IS NULL AND milestone_id IS NULL",
};

/** What the setup page handed over: when, and the token sealed for later when the person chose to keep the copy updated. */
export interface SetupClaim {
  readonly claimedAt: string;
  readonly sealedToken: string | null;
  readonly keepUpdated: boolean;
}

/** A signed release the daily check found, newer than the running copy. */
export interface UpdateOffer {
  readonly version: string;
  readonly manifest: string;
  readonly signature: string;
}

/** The last daily check: when it ran, and the offer it kept, if any. */
export interface UpdateCheckRecord {
  readonly checkedAt: string;
  readonly offer: UpdateOffer | null;
  /** The newest signed issue date any release read so far carried; a feed older than this is refused. Null before the first. */
  readonly issuedAt: string | null;
}

/** The one update in progress or just done. Ids are Cloudflare's own; none is a secret. */
export interface UpdateRun {
  readonly version: string;
  readonly step: string;
  readonly state: string;
  readonly accountId: string | null;
  readonly databaseId: string | null;
  readonly workerName: string | null;
  readonly previousVersionId: string | null;
  /** The release the copy ran before this run, in words ("0.1.0"), for the Go back row. */
  readonly previousVersion: string | null;
  readonly newVersionId: string | null;
  readonly bookmark: string | null;
  readonly migrated: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly backUntil: string | null;
}

/** A run untouched this long is no longer open, so an offer that moved on is not stuck behind it. */
const UPDATE_RUN_OPEN_MS = 24 * 60 * 60 * 1000;
/** A step held this long without an answer is taken to have died. */
const UPDATE_STEP_HOLD_MS = 60 * 1000;

/**
 * What the VEMI-013 trim cut. The export leaves it out and a restore ignores it, so an old
 * file that still holds it restores without error whether or not this copy still has it.
 */
const CUT_TABLES: readonly string[] = ["venture_link", "duty"];
const CUT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  venture: ["map_x", "map_y", "map_z", "board_x", "board_y"],
  project: ["board_x", "board_y"],
  task: ["parked_at", "icon", "size"],
};

export const EXPORT_EXCLUDED: readonly string[] = ["credential", "recovery_code", "challenge", "backup_run", "email_token", "invite", ...CUT_TABLES, "connector_code", "connector_grant", "key_pairing"];

/** A `CREATE TABLE` column line naming `owner`, as every migration in this tree writes it. */
const OWNER_COLUMN = /^\s*"?owner"?\s+TEXT\b/im;

/**
 * Tables a restore neither reads nor clears, though they carry an owner: a device's push
 * subscription and what it was already sent belong to that device, and the connector's
 * record of what an app changed names records by ids that a restore makes new.
 */
const RESTORE_KEPT = ["push_subscription", "reminder_sent", "connector_change"];

/** One table that has an owner column, as the schema itself describes it. */
interface OwnedTable {
  readonly name: string;
  readonly columns: readonly string[];
  /** Whether `id` alone is the primary key, so each row is a record that gets a new id. */
  readonly ownId: boolean;
  /** Each column that names a row of another table, or of this one. */
  readonly refs: readonly { readonly column: string; readonly table: string }[];
}

/** Parents before children, by the foreign keys between these tables. A table naming itself is not waiting on itself. */
function parentsFirst(tables: readonly OwnedTable[]): OwnedTable[] {
  const names = new Set(tables.map((t) => t.name));
  const done = new Set<string>();
  const out: OwnedTable[] = [];
  let left = [...tables];
  while (left.length > 0) {
    const ready = left.filter((t) => t.refs.every((r) => r.table === t.name || !names.has(r.table) || done.has(r.table)));
    if (ready.length === 0) throw new Error(`tables wait on each other: ${left.map((t) => t.name).join(", ")}`);
    for (const t of ready) {
      done.add(t.name);
      out.push(t);
    }
    left = left.filter((t) => !done.has(t.name));
  }
  return out;
}

/** Seven days, in milliseconds: how long an account waits between asking to go and going. */
const DELETION_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v);
/** A number column that may be null: board coordinates and today's order both are. */
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function recorded(r: Row) {
  return {
    id: str(r.id),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: optStr(r.archived_at),
  };
}

function parseChecklist(v: unknown): ChecklistItem[] {
  try {
    const parsed: unknown = JSON.parse(String(v ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i): i is { text: unknown; done: unknown } => typeof i === "object" && i !== null && "text" in i)
      .map((i) => ({ text: String(i.text), done: i.done === true }));
  } catch {
    return [];
  }
}

/** The views a space has on. A stored list this build cannot read, or an empty one, is both. */
function viewsOf(v: unknown): readonly VentureView[] {
  const list = storedJson(v);
  const on = Array.isArray(list) ? VENTURE_VIEWS.filter((view) => list.includes(view)) : [];
  return on.length === 0 ? VENTURE_VIEWS : on;
}

function parseJson<T>(v: unknown): T | null {
  if (typeof v !== "string") return null;
  return JSON.parse(v) as T;
}

const MAP: { readonly [K in Kind]: (r: Row) => Records[K] } = {
  ventures: (r): Venture => ({
    ...recorded(r), name: str(r.name), icon: optStr(r.icon), description: optStr(r.description),
    position: num(r.position), parentId: optStr(r.parent_id),
    views: viewsOf(r.views), monogram: optStr(r.monogram),
    stageId: optStr(r.stage_id), atRisk: num(r.at_risk) === 1,
  }),
  states: (r): State => ({
    ...recorded(r), ventureId: str(r.venture_id), name: str(r.name), kind: str(r.kind) as StateKind,
    position: num(r.position),
  }),
  stages: (r): Stage => ({
    ...recorded(r), ventureId: str(r.venture_id), name: str(r.name), kind: str(r.kind) as StageKind,
    position: num(r.position),
  }),
  projects: (r): Project => ({
    ...recorded(r), ventureId: str(r.venture_id), name: str(r.name), icon: optStr(r.icon),
    description: optStr(r.description), position: num(r.position),
    parentId: optStr(r.parent_id),
    stageId: optStr(r.stage_id), atRisk: num(r.at_risk) === 1,
    pinnedAt: optStr(r.pinned_at),
    whoFor: optStr(r.who_for), doneLooks: optStr(r.done_looks), openQuestions: optStr(r.open_questions),
  }),
  milestones: (r): Milestone => ({
    ...recorded(r), projectId: str(r.project_id), stateId: optStr(r.state_id), name: str(r.name),
    aimingOn: optStr(r.aiming_on), position: num(r.position),
  }),
  tasks: (r): Task => ({
    ...recorded(r), ventureId: str(r.venture_id), projectId: optStr(r.project_id),
    milestoneId: optStr(r.milestone_id), stateId: optStr(r.state_id), title: str(r.title), body: optStr(r.body),
    checklist: parseChecklist(r.checklist), priority: optStr(r.priority) as Priority | null,
    dueOn: optStr(r.due_on), pickedOn: optStr(r.picked_on), position: num(r.position),
    todayPosition: optNum(r.today_position),
    remindAt: optStr(r.remind_at), repeat: optStr(r.repeat),
  }),
  blockers: (r): Blocker => ({
    ...recorded(r), taskId: str(r.task_id), reason: str(r.reason), waitsOnTaskId: optStr(r.waits_on_task_id),
    person: optStr(r.person), sinceOn: optStr(r.since_on),
  }),
  notes: (r): Note => ({
    ...recorded(r), ventureId: optStr(r.venture_id), projectId: optStr(r.project_id), body: str(r.body),
  }),
  decisions: (r): Decision => ({
    ...recorded(r), ventureId: optStr(r.venture_id), projectId: optStr(r.project_id), title: str(r.title),
    body: optStr(r.body), decidedOn: optStr(r.decided_on), position: num(r.position),
  }),
  risks: (r): Risk => ({
    ...recorded(r), ventureId: optStr(r.venture_id), projectId: optStr(r.project_id), title: str(r.title),
    body: optStr(r.body), raisedOn: optStr(r.raised_on), position: num(r.position),
  }),
  links: (r): Link => ({
    ...recorded(r), ventureId: optStr(r.venture_id), projectId: optStr(r.project_id), taskId: optStr(r.task_id),
    url: str(r.url), label: optStr(r.label), role: str(r.role) as LinkRole,
  }),
  tags: (r): Tag => ({ ...recorded(r), name: str(r.name) }),
};

function withBlocker(r: Row): TaskWithBlocker {
  return { ...MAP.tasks(r), blocker: parseJson<Blocker>(r.blocker_json), tagIds: tagIdsOf(r) };
}

/** The tag ids a row carried, for a statement that asked for them with `TAG_IDS`. */
function tagIdsOf(r: Row): string[] {
  return parseJson<string[]>(r.tag_ids) ?? [];
}

// ---------------------------------------------------------------------------
// Visibility. Every fragment is parameter-free, so it composes into any statement.
// ---------------------------------------------------------------------------

const ventureVisible = (a: string): string =>
  `${a}.archived_at IS NULL AND (${a}.parent_id IS NULL OR EXISTS ` +
  `(SELECT 1 FROM venture ${a}_up WHERE ${a}_up.id = ${a}.parent_id AND ${a}_up.archived_at IS NULL))`;

const inVisibleVenture = (col: string, a: string): string =>
  `EXISTS (SELECT 1 FROM venture ${a} WHERE ${a}.id = ${col} AND ${ventureVisible(a)})`;

/** A project inside another is seen only while the one it is inside is live. */
const parentLive = (a: string): string =>
  `${a}.parent_id IS NULL OR EXISTS (SELECT 1 FROM project ${a}_up WHERE ${a}_up.id = ${a}.parent_id AND ${a}_up.archived_at IS NULL)`;

const projectVisible = (a: string): string =>
  `${a}.archived_at IS NULL AND ${inVisibleVenture(`${a}.venture_id`, `${a}_v`)} AND (${parentLive(a)})`;

const milestoneVisible = (a: string): string =>
  `${a}.archived_at IS NULL AND EXISTS (SELECT 1 FROM project ${a}_p WHERE ${a}_p.id = ${a}.project_id AND ${projectVisible(`${a}_p`)})`;

const taskVisible = (a: string): string =>
  `${a}.archived_at IS NULL AND ${inVisibleVenture(`${a}.venture_id`, `${a}_v`)}` +
  ` AND (${a}.project_id IS NULL OR EXISTS (SELECT 1 FROM project ${a}_p WHERE ${a}_p.id = ${a}.project_id AND ${a}_p.archived_at IS NULL AND (${parentLive(`${a}_p`)})))` +
  ` AND (${a}.milestone_id IS NULL OR EXISTS (SELECT 1 FROM milestone ${a}_m WHERE ${a}_m.id = ${a}.milestone_id AND ${a}_m.archived_at IS NULL))`;

const inVisibleTask = (col: string, a: string): string =>
  `EXISTS (SELECT 1 FROM task ${a} WHERE ${a}.id = ${col} AND ${taskVisible(a)})`;

/** A decision or a risk is seen while its venture or its project is. */
const ledgerVisible = (a: string): string =>
  `${a}.archived_at IS NULL AND (${inVisibleVenture(`${a}.venture_id`, `${a}_v`)}` +
  ` OR EXISTS (SELECT 1 FROM project ${a}_p WHERE ${a}_p.id = ${a}.project_id AND ${projectVisible(`${a}_p`)}))`;

/** The venture a decision or a risk sits in, directly or through its project. */
const ledgerVentureOf = (a: string): string =>
  `COALESCE(${a}.venture_id, (SELECT ${a}_vp.venture_id FROM project ${a}_vp WHERE ${a}_vp.id = ${a}.project_id))`;

const VISIBLE: Readonly<Record<Kind, (a: string) => string>> = {
  ventures: ventureVisible,
  states: (a) => `${a}.archived_at IS NULL AND ${inVisibleVenture(`${a}.venture_id`, `${a}_v`)}`,
  stages: (a) => `${a}.archived_at IS NULL AND ${inVisibleVenture(`${a}.venture_id`, `${a}_v`)}`,
  projects: projectVisible,
  milestones: milestoneVisible,
  tasks: taskVisible,
  blockers: (a) => `${a}.archived_at IS NULL AND ${inVisibleTask(`${a}.task_id`, `${a}_t`)}`,
  notes: (a) =>
    `${a}.archived_at IS NULL AND (${inVisibleVenture(`${a}.venture_id`, `${a}_v`)}` +
    ` OR EXISTS (SELECT 1 FROM project ${a}_p WHERE ${a}_p.id = ${a}.project_id AND ${projectVisible(`${a}_p`)}))`,
  decisions: ledgerVisible,
  risks: ledgerVisible,
  links: (a) =>
    `${a}.archived_at IS NULL AND (${inVisibleVenture(`${a}.venture_id`, `${a}_v`)}` +
    ` OR EXISTS (SELECT 1 FROM project ${a}_p WHERE ${a}_p.id = ${a}.project_id AND ${projectVisible(`${a}_p`)})` +
    ` OR ${inVisibleTask(`${a}.task_id`, `${a}_t`)})`,
  // A tag sits in nothing, so nothing above it can hide it. Its own stamp is the whole test.
  tags: (a) => `${a}.archived_at IS NULL`,
};

/**
 * True for a column holding a whole sealed envelope: `v1.`, an 11 character key ref, a 16
 * character iv, then 22 or more characters of data and nothing else. The same rule as
 * `isSealed` in shared. D1 refuses a GLOB pattern over 50 bytes and GLOB has no quantifiers,
 * so the dots are placed by position, the alphabet by one GLOB, and a fourth dot by another.
 */
const sealedSql = (col: string): string =>
  `(substr(${col}, 1, 3) = 'v1.' AND substr(${col}, 15, 1) = '.' AND substr(${col}, 32, 1) = '.' AND length(${col}) >= 54` +
  ` AND ${col} NOT GLOB '*[^A-Za-z0-9_.-]*' AND ${col} NOT GLOB 'v1.*.*.*.*')`;

/** The lockable columns, by record kind: the column and the name a client knows it by. */
const LOCKED_COLUMNS = {
  projects: { table: "project", columns: [["description", "description"], ["who_for", "whoFor"], ["done_looks", "doneLooks"], ["open_questions", "openQuestions"]] },
  tasks: { table: "task", columns: [["body", "body"]] },
  notes: { table: "note", columns: [["body", "body"]] },
} as const;

/** How many sealed fields a file's rows hold, so a restore can say so before it replaces anything. */
export function countLocked(tables: RestoreFile["tables"]): number {
  let n = 0;
  for (const spec of Object.values(LOCKED_COLUMNS)) {
    for (const row of tables[spec.table] ?? []) {
      for (const [column] of spec.columns) {
        const v = row[column];
        if (typeof v === "string" && isSealed(v)) n++;
      }
    }
  }
  return n;
}

/**
 * Where each typed cell lives, for full encryption: the table, whether the row names its owner
 * (the settings row is the account itself), and each field's column. `checklist` is the one
 * cell that holds a list. The fields are those of `ENCRYPTED_FIELDS`, and `connector_change`'s
 * `before`.
 */
const SEAL_TABLES: Readonly<Record<SealKind, { readonly table: string; readonly owned: boolean; readonly columns: Readonly<Record<string, string>> }>> = {
  ventures: { table: "venture", owned: true, columns: { name: "name", description: "description", monogram: "monogram" } },
  states: { table: "state", owned: true, columns: { name: "name" } },
  stages: { table: "stage", owned: true, columns: { name: "name" } },
  projects: {
    table: "project", owned: true,
    columns: { name: "name", description: "description", whoFor: "who_for", doneLooks: "done_looks", openQuestions: "open_questions" },
  },
  milestones: { table: "milestone", owned: true, columns: { name: "name" } },
  tasks: { table: "task", owned: true, columns: { title: "title", body: "body", checklist: "checklist" } },
  blockers: { table: "blocker", owned: true, columns: { reason: "reason", person: "person" } },
  notes: { table: "note", owned: true, columns: { body: "body" } },
  decisions: { table: "decision", owned: true, columns: { title: "title", body: "body" } },
  risks: { table: "risk", owned: true, columns: { title: "title", body: "body" } },
  links: { table: "link", owned: true, columns: { url: "url", label: "label" } },
  tags: { table: "tag", owned: true, columns: { name: "name" } },
  savedFilters: { table: "saved_filter", owned: true, columns: { name: "name", query: "query" } },
  settings: {
    table: "account", owned: false,
    columns: {
      levelSpace: "level_space", levelProject: "level_project", levelMilestone: "level_milestone", levelTask: "level_task",
      defaultStages: "default_stages",
    },
  },
  connector_change: { table: "connector_change", owned: true, columns: { before: "before" } },
};

/** True for a column a person can lock: an envelope there may be the lock's, and full encryption leaves it be. */
const isLockColumn = (table: string, column: string): boolean =>
  Object.values(LOCKED_COLUMNS).some((l) => l.table === table && l.columns.some(([c]) => c === column));

/** The first typed field of `fields` that holds plain text, or null. A checklist counts by its items' text. */
function plainTyped(kind: string, fields: object): string | null {
  const names = (ENCRYPTED_FIELDS as Readonly<Record<string, readonly string[]>>)[kind];
  if (names === undefined) return null;
  for (const [key, value] of Object.entries(fields)) {
    if (key === "checklist" && kind === "tasks") {
      if (Array.isArray(value) && value.some((item: unknown) => {
        const text = (item as { text?: unknown } | null)?.text;
        return typeof text === "string" && !isEnvelopeShape(text);
      })) return key;
    } else if (names.includes(key) && typeof value === "string" && !isEnvelopeShape(value)) {
      return key;
    }
  }
  return null;
}

/**
 * Whether a restored row holds typed text that is not an envelope, in a table full encryption seals. A file from an
 * account that never sealed holds plain text there, and an account that is on may hold only envelopes.
 */
function plainRestoredCell(table: string, row: Readonly<Record<string, unknown>>): boolean {
  for (const spec of Object.values(SEAL_TABLES)) {
    if (spec.table !== table || !spec.owned) continue;
    for (const column of Object.values(spec.columns)) {
      const v = row[column];
      if (typeof v !== "string" || v === "") continue;
      if (table === "task" && column === "checklist") {
        const items = storedJson(v);
        if (Array.isArray(items) && items.some((i: unknown) => {
          const text = (i as { text?: unknown } | null)?.text;
          return typeof text === "string" && text !== "" && !isEnvelopeShape(text);
        })) return true;
      } else if (!isEnvelopeShape(v)) {
        return true;
      }
    }
  }
  return false;
}

/** The venture a row sits in, as an expression over alias `a`. */
/**
 * How a record says which one it is, in one line. Read by the archive and by a delete's
 * preview, so the thing a person is asked to confirm is the thing the archive listed.
 */
const LABEL: Readonly<Record<Kind, string>> = {
  ventures: "x.name",
  states: "x.name",
  stages: "x.name",
  projects: "x.name",
  milestones: "x.name",
  tasks: "x.title",
  blockers: "x.reason",
  // A sealed body is never cut: cut, an envelope could not be opened. In an account that is
  // sealing its text the device opens the whole of it; otherwise it is a locked note and reads Locked.
  notes: `CASE WHEN ${sealedSql("x.body")} THEN` +
    ` CASE WHEN (SELECT a.encryption FROM account a WHERE a.id = x.owner) <> 'off' THEN x.body ELSE 'Locked' END` +
    ` ELSE substr(x.body, 1, 120) END`,
  decisions: "x.title",
  risks: "x.title",
  links: "COALESCE(x.label, x.url)",
  tags: "x.name",
};

/**
 * Which kinds have a name of their own to type. Decision 33 asks for the record's own name;
 * a blocker's label is its reason, a note's is its first line and a link's is a URL, and
 * asking anyone to retype 120 characters of prose is a dark pattern, not a safeguard.
 */
const NAMED: Readonly<Record<Kind, boolean>> = {
  ventures: true, states: true, stages: true, projects: true, milestones: true,
  tasks: true, blockers: false, notes: false, decisions: true, risks: true, links: false, tags: true,
};

const VENTURE_OF: Readonly<Record<Kind, (a: string) => string>> = {
  ventures: (a) => `${a}.id`,
  states: (a) => `${a}.venture_id`,
  stages: (a) => `${a}.venture_id`,
  projects: (a) => `${a}.venture_id`,
  milestones: (a) => `(SELECT ${a}_vo.venture_id FROM project ${a}_vo WHERE ${a}_vo.id = ${a}.project_id)`,
  tasks: (a) => `${a}.venture_id`,
  blockers: (a) => `(SELECT ${a}_vo.venture_id FROM task ${a}_vo WHERE ${a}_vo.id = ${a}.task_id)`,
  notes: (a) =>
    `COALESCE(${a}.venture_id,` +
    ` (SELECT ${a}_vp.venture_id FROM project ${a}_vp WHERE ${a}_vp.id = ${a}.project_id))`,
  decisions: ledgerVentureOf,
  risks: ledgerVentureOf,
  links: (a) =>
    `COALESCE(${a}.venture_id,` +
    ` (SELECT ${a}_vp.venture_id FROM project ${a}_vp WHERE ${a}_vp.id = ${a}.project_id),` +
    ` (SELECT ${a}_vt.venture_id FROM task ${a}_vt WHERE ${a}_vt.id = ${a}.task_id))`,
  // A tag spans ventures and belongs to none, so there is no venture to name. A client told
  // that a tag changed reads everything again, which is what it does for any change at all.
  tags: () => "NULL",
};

/** What each kind can be listed by. Each fragment takes exactly one parameter. */
const FILTERS: { readonly [K in Kind]: Readonly<Record<string, (a: string) => string>> } = {
  ventures: { parent: (a) => `${a}.parent_id = ?` },
  states: { venture: (a) => `${a}.venture_id = ?` },
  stages: { venture: (a) => `${a}.venture_id = ?` },
  projects: { venture: (a) => `${a}.venture_id = ?`, parent: (a) => `${a}.parent_id = ?` },
  milestones: { venture: (a) => `${VENTURE_OF.milestones(a)} = ?`, project: (a) => `${a}.project_id = ?` },
  tasks: {
    venture: (a) => `${a}.venture_id = ?`, project: (a) => `${a}.project_id = ?`,
    milestone: (a) => `${a}.milestone_id = ?`, state: (a) => `${a}.state_id = ?`,
  },
  blockers: { venture: (a) => `${VENTURE_OF.blockers(a)} = ?`, task: (a) => `${a}.task_id = ?` },
  notes: { venture: (a) => `${VENTURE_OF.notes(a)} = ?`, project: (a) => `${a}.project_id = ?` },
  decisions: { venture: (a) => `${VENTURE_OF.decisions(a)} = ?`, project: (a) => `${a}.project_id = ?` },
  risks: { venture: (a) => `${VENTURE_OF.risks(a)} = ?`, project: (a) => `${a}.project_id = ?` },
  links: {
    venture: (a) => `${VENTURE_OF.links(a)} = ?`,
    project: (a) => `${a}.project_id = ?`,
    task: (a) => `${a}.task_id = ?`,
  },
  tags: {},
};

const ORDER: Readonly<Record<Kind, (a: string) => string>> = {
  ventures: (a) => `${a}.position, ${a}.created_at`,
  states: (a) => `${a}.position, ${a}.created_at`,
  stages: (a) => `${a}.position, ${a}.created_at`,
  projects: (a) => `${a}.position, ${a}.created_at`,
  // Ordered by the date aimed at. Ordering is the only thing a milestone date is used for.
  milestones: (a) => `${a}.aiming_on IS NULL, ${a}.aiming_on, ${a}.position`,
  tasks: (a) => `${a}.position, ${a}.created_at`,
  blockers: (a) => `${a}.created_at`,
  notes: (a) => `${a}.updated_at DESC`,
  decisions: (a) => `${a}.position, ${a}.created_at`,
  risks: (a) => `${a}.position, ${a}.created_at`,
  links: (a) => `${a}.created_at`,
  // By name, so a list to choose from arrives in the order it is read in and the client
  // never sorts it. A tag has no position: there is nothing to drag it into.
  tags: (a) => `${a}.name`,
};

const BLOCKER_JSON = (a: string): string =>
  `(SELECT json_object('id', b.id, 'taskId', b.task_id, 'reason', b.reason, 'waitsOnTaskId', b.waits_on_task_id,` +
  ` 'person', b.person, 'sinceOn', b.since_on, 'createdAt', b.created_at, 'updatedAt', b.updated_at,` +
  ` 'archivedAt', b.archived_at) FROM blocker b WHERE b.task_id = ${a}.id AND b.archived_at IS NULL)`;

/**
 * The tags on a task or a project, as a JSON array of ids ordered by the tag's name.
 *
 * Ordered in the statement that reads the row, so a list arrives ready to show and the
 * client never sorts. `json_group_array` over nothing is `[]`, so a row with no tags on it
 * needs no special case, and an archived tag drops out here rather than being deleted: an
 * assignment is put away by putting away either end of it.
 */
const TAG_IDS = (edge: Edge, a: string): string =>
  `(SELECT json_group_array(tag_id) FROM (SELECT e.tag_id FROM ${EDGE_TABLE[edge]} e` +
  ` JOIN tag g ON g.id = e.tag_id WHERE e.${EDGE_COLUMN[edge]} = ${a}.id AND ${VISIBLE.tags("g")}` +
  ` ORDER BY g.name))`;

/** Tasks and milestones in a finished state are done; no state at all means not started. */
const NOT_FINISHED = (kindCol: string): string => `(${kindCol} IS NULL OR ${kindCol} <> 'finished')`;

// ---------------------------------------------------------------------------
// Rules: a condition a write must meet, and what to say when it does not.
// ---------------------------------------------------------------------------

interface Rule {
  readonly sql: string;
  readonly binds: readonly unknown[];
  readonly status: 400 | 404 | 409;
  readonly error: string;
}

const rule = (sql: string, binds: readonly unknown[], status: Rule["status"], error: string): Rule =>
  ({ sql, binds, status, error });

const whereOf = (rules: readonly Rule[]): string =>
  rules.length === 0 ? "1" : rules.map((r) => `(${r.sql})`).join(" AND ");

const ventureRule = (owner: string, id: string, what = "venture"): Rule =>
  rule(`EXISTS (SELECT 1 FROM venture r WHERE r.id = ? AND r.owner = ? AND ${ventureVisible("r")})`,
    [id, owner], 404, `${what} ${id} was not found`);

const projectRule = (owner: string, id: string): Rule =>
  rule(`EXISTS (SELECT 1 FROM project r WHERE r.id = ? AND r.owner = ? AND ${projectVisible("r")})`,
    [id, owner], 404, `project ${id} was not found`);

const taskRule = (owner: string, id: string): Rule =>
  rule(`EXISTS (SELECT 1 FROM task r WHERE r.id = ? AND r.owner = ? AND ${taskVisible("r")})`,
    [id, owner], 404, `task ${id} was not found`);

/**
 * A tag is a word, so an empty one is nothing at all. The column's own CHECK would refuse
 * it too, but only as "the database refused a value": this says which field and why.
 */
const tagName = (name: string): Rule =>
  rule(`length(trim(?)) > 0`, [name], 400, "a tag needs a name");

/**
 * The tag a write says to put on something has to be this owner's, and still live. An
 * archived tag is refused here rather than quietly dropped: it is a word the person put
 * away, and a client sending it is working from a list it should refresh.
 */
const tagRule = (owner: string, id: string): Rule =>
  rule(`EXISTS (SELECT 1 FROM tag r WHERE r.id = ? AND r.owner = ? AND ${VISIBLE.tags("r")})`,
    [id, owner], 404, `tag ${id} was not found`);

const projectInVenture = (owner: string, projectId: string, ventureId: string): Rule =>
  rule(`EXISTS (SELECT 1 FROM project r WHERE r.id = ? AND r.owner = ? AND r.venture_id = ? AND r.archived_at IS NULL AND (${parentLive("r")}))`,
    [projectId, owner, ventureId], 400, `project ${projectId} is not in venture ${ventureId}`);

const milestoneInProject = (owner: string, milestoneId: string, projectId: string): Rule =>
  rule(`EXISTS (SELECT 1 FROM milestone r WHERE r.id = ? AND r.owner = ? AND r.project_id = ? AND r.archived_at IS NULL)`,
    [milestoneId, owner, projectId], 400, `milestone ${milestoneId} is not in project ${projectId}`);

const stateInVenture = (owner: string, stateId: string, ventureId: string): Rule =>
  rule(`EXISTS (SELECT 1 FROM state r WHERE r.id = ? AND r.owner = ? AND r.venture_id = ? AND r.archived_at IS NULL)`,
    [stateId, owner, ventureId], 400, `state ${stateId} is not one of venture ${ventureId}'s states`);

const stageInVenture = (owner: string, stageId: string, ventureId: string): Rule =>
  rule(`EXISTS (SELECT 1 FROM stage r WHERE r.id = ? AND r.owner = ? AND r.venture_id = ? AND r.archived_at IS NULL)`,
    [stageId, owner, ventureId], 400, `stage ${stageId} is not one of venture ${ventureId}'s lifecycle stages`);

const stateForProject = (owner: string, stateId: string, projectId: string): Rule =>
  rule(`EXISTS (SELECT 1 FROM state r JOIN project rp ON rp.venture_id = r.venture_id` +
    ` WHERE r.id = ? AND r.owner = ? AND rp.id = ? AND r.archived_at IS NULL)`,
    [stateId, owner, projectId], 400, `state ${stateId} is not one of this project's venture's states`);

const parentRules = (owner: string, parentId: string): Rule[] => [
  ventureRule(owner, parentId, "parent venture"),
  rule(`NOT EXISTS (SELECT 1 FROM venture r WHERE r.id = ? AND r.parent_id IS NOT NULL)`, [parentId], 409,
    `ventures nest two levels deep, and ${parentId} already has a parent`),
];

/**
 * A project may sit inside another only when that one is this owner's, in the venture the
 * project will be in, live, and not itself inside a project. One level, as ventures have.
 */
const projectParentRules = (owner: string, parentId: string, ventureId: string): Rule[] => [
  rule(`EXISTS (SELECT 1 FROM project r WHERE r.id = ? AND r.owner = ? AND r.venture_id = ? AND ${projectVisible("r")})`,
    [parentId, owner, ventureId], 404, `parent project ${parentId} was not found in venture ${ventureId}`),
  rule(`NOT EXISTS (SELECT 1 FROM project r WHERE r.id = ? AND r.parent_id IS NOT NULL)`, [parentId], 409,
    `projects nest one level deep, and ${parentId} is already inside a project`),
];

/** The first state of the same kind in another venture, for a thing moving there. */
const MAPPED_STATE =
  `(SELECT s2.id FROM state s2 WHERE s2.venture_id = ? AND s2.archived_at IS NULL` +
  ` AND s2.kind = (SELECT s1.kind FROM state s1 WHERE s1.id = ?) ORDER BY s2.position, s2.created_at LIMIT 1)`;

/** The first stage of the same kind in another venture, for a project moving there. */
const MAPPED_STAGE =
  `(SELECT g2.id FROM stage g2 WHERE g2.venture_id = ? AND g2.archived_at IS NULL` +
  ` AND g2.kind = (SELECT g1.kind FROM stage g1 WHERE g1.id = ?) ORDER BY g2.position, g2.created_at LIMIT 1)`;

type Col = readonly [column: string, sql: string, binds: readonly unknown[]];

const col = (column: string, value: unknown): Col => [column, "?", [value ?? null]];

/** Columns a patch sets, for the keys it carries. */
function patched(patch: object, fields: readonly (readonly [key: string, column: string])[]): Col[] {
  const out: Col[] = [];
  const p = patch as Record<string, unknown>;
  for (const [key, column] of fields) {
    if (key in p) out.push(col(column, p[key]));
  }
  return out;
}

function constraintOutcome(e: unknown): Outcome<never> {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("UNIQUE constraint failed")) {
    return { ok: false, status: 409, error: "that would duplicate something that already exists" };
  }
  if (/CHECK constraint failed|NOT NULL constraint failed|FOREIGN KEY constraint failed/.test(message)) {
    return { ok: false, status: 400, error: "the database refused a value that breaks its schema" };
  }
  throw e;
}

const accountFrom = (r: Row): AccountSecret => ({
  id: str(r.id),
  email: str(r.email),
  confirmed: r.email_confirmed_at !== null && r.email_confirmed_at !== undefined,
  hasPassword: r.password_hash !== null && r.password_hash !== undefined,
  google: r.google_sub !== null && r.google_sub !== undefined,
  passwordHash: optStr(r.password_hash),
  googleSub: optStr(r.google_sub),
  generation: num(r.session_generation),
  twoStepSecret: optStr(r.two_step_secret),
  twoStepOnAt: optStr(r.two_step_on_at),
  totpLastStep: r.totp_last_step === null || r.totp_last_step === undefined ? null : num(r.totp_last_step),
  backupCodes: backupCodesFrom(r.backup_codes),
  deleteOn: optStr(r.delete_on),
  firstName: optStr(r.first_name),
});

function backupCodesFrom(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(typeof value === "string" ? value : "[]");
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/**
 * What an account keeps beside its look: the space new tasks go to (null means the space used
 * last) and the day of its last weekly review.
 */
export interface CaptureSettings {
  readonly newTaskVentureId: string | null;
  readonly lastReviewOn: string | null;
}

/** What the person chose to be told, and when to hold it. Everything starts off. */
export interface ReminderSettings {
  /** `HH:MM` the morning summary goes out, or null for none. */
  readonly morningAt: string | null;
  readonly taskReminders: boolean;
  /** `HH:MM` the quiet window starts and ends, or null for none. */
  readonly quietFrom: string | null;
  readonly quietTo: string | null;
}

/** Most saved filters one account keeps. */
export const FILTERS_MOST = 30;

/** A search a person saved: a name and the words typed. */
export interface SavedFilter {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly position: number;
  readonly createdAt: string;
}

export interface NewSavedFilter {
  /** A id the client chose, so a sealed name can be bound to it before it is sent. */
  readonly id?: string;
  readonly name: string;
  readonly query: string;
}

function filterFrom(row: Row): SavedFilter {
  return {
    id: String(row.id), name: String(row.name), query: String(row.query),
    position: Number(row.position), createdAt: String(row.created_at),
  };
}

/** An app that asked to be let in. Nobody owns it: it is only a name and where it may send a person back to. */
export interface ConnectorClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

/** What the person's Allow left behind until the app trades it for tokens. Only the hash of the code is kept. */
export interface NewConnectorCode {
  readonly hash: string;
  readonly clientId: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly expiresAt: string;
}

export interface ConnectorCode extends NewConnectorCode {
  readonly owner: string;
}

/** Hashes of the two secrets, never the secrets. `expiresAt` is when the access token stops. */
export interface NewConnectorTokens {
  readonly tokenHash: string;
  readonly refreshHash: string;
  readonly expiresAt: string;
}

/** One person's Allow for one app, as every reader sees it: no hash of any kind. */
export interface ConnectorGrant {
  readonly id: string;
  readonly owner: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface NewConnectorChange {
  readonly grantId: string;
  readonly clientName: string;
  readonly tool: string;
  readonly kind: Kind;
  readonly recordId: string;
  /** The record's values before the change, or null when the change made the record. */
  readonly before: unknown;
}

export interface ConnectorChange extends NewConnectorChange {
  readonly id: string;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

function clientFrom(row: Row): ConnectorClient {
  return { id: str(row.id), name: str(row.name), redirectUris: JSON.parse(str(row.redirect_uris)) as string[] };
}

function grantFrom(row: Row): ConnectorGrant {
  return {
    id: str(row.id), owner: str(row.owner), clientId: str(row.client_id), clientName: str(row.client_name),
    expiresAt: str(row.expires_at), createdAt: str(row.created_at), lastUsedAt: optStr(row.last_used_at),
  };
}

function changeFrom(row: Row): ConnectorChange {
  return {
    id: str(row.id), grantId: str(row.grant_id), clientName: str(row.client_name), tool: str(row.tool),
    kind: str(row.kind) as Kind, recordId: str(row.record_id),
    // A sealed `before` is one envelope, not JSON, and is answered as the text it is.
    before: row.before === null || row.before === undefined ? null : isEnvelopeShape(str(row.before)) ? str(row.before) : JSON.parse(str(row.before)),
    createdAt: str(row.created_at), undoneAt: optStr(row.undone_at),
  };
}

/** A device's subscription as the browser gives it, plus the zone that device is in. */
export interface NewPushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly label: string | null;
  readonly tz: string;
}

/** A subscription as the routes show it: never the keys a message is encrypted to. */
export interface PushSubscriptionSummary {
  readonly id: string;
  readonly endpoint: string;
  readonly label: string | null;
  readonly tz: string;
  readonly createdAt: string;
  readonly lastOkAt: string | null;
}

/** An account the tick may send to: its settings and the zone its newest device is in. */
export interface ReminderAccount {
  readonly owner: string;
  readonly settings: ReminderSettings;
  readonly tz: string | null;
  /** Anything but `off` keeps titles off the push: they travel sealed or not at all. */
  readonly encryption: EncryptionState;
}

/** One subscribed device with the keys a message is encrypted to. */
export interface PushDevice {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface DueReminder {
  readonly taskId: string;
  readonly title: string;
  readonly remindAt: string;
}

/** A P-256 pair as base64url: the uncompressed public point, and the private scalar. */
export interface StoredVapidKey {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** First-run progress: the step (1 to 7, null when finished or never started) and the tips shown (null: none to show). */
export interface FirstRun {
  readonly step: number | null;
  readonly tipsSeen: readonly string[] | null;
}

/** Exactly one of a new step or one tip name. */
export type FirstRunChange = { readonly step: number | null } | { readonly tipSeen: string };

/** What a way in or a device is. Only `device` carries no wrapped copy of the account key. */
export type KeyKind = "passkey" | "password" | "recovery" | "device";

/** One row of `key_wrap` as a device sends it. `id` is the device's own, so a passkey row can name its device row. */
export interface KeyWrapInput {
  readonly id: string;
  readonly kind: KeyKind;
  readonly label: string;
  readonly deviceId: string | null;
  readonly credentialId: string | null;
  readonly salt: string | null;
  readonly iterations: number | null;
  readonly wrapped: string | null;
}

export interface KeyWrap extends KeyWrapInput {
  readonly createdAt: string;
}

/** The live rows of one account key. `keyRef` and `keyCheck` are null when there is no key. */
export interface KeySet {
  readonly keyRef: string | null;
  readonly keyCheck: string | null;
  readonly wraps: KeyWrap[];
}

export interface KeyBundle {
  readonly keyRef: string;
  readonly keyCheck: string;
  readonly wraps: KeyWrapInput[];
}

export type PairingRead = { readonly waiting: true } | { readonly sealed: string };

/** How long a pairing stays open for the other device to fill, in milliseconds. */
export const PAIRING_MS = 10 * 60 * 1000;

export const TIPS_KEPT = 20;

const firstRunFrom = (r: Row): FirstRun => {
  let tipsSeen: string[] | null = null;
  if (typeof r.tips_seen === "string") {
    try {
      const list: unknown = JSON.parse(r.tips_seen);
      tipsSeen = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
      tipsSeen = [];
    }
  }
  return { step: r.first_run_step === null || r.first_run_step === undefined ? null : num(r.first_run_step), tipsSeen };
};

/** The whole of what the appearance routes carry. */
export type AccountSettings = Appearance & CaptureSettings & ReminderSettings & AccountProfile;

/** What a person chose for their whole copy: names, starting stages, first screen, Extras, zone. */
export interface AccountProfile {
  /** What the four levels are called. A level never named reads as its shipped word. */
  readonly levelNames: AccountLevelNames;
  /**
   * The stages a new space starts with, in order, or null for Idea, Building, Live, Paused, Stopped.
   * A fully encrypted account holds the whole list as one envelope, which is a string here.
   */
  readonly defaultStages: readonly { readonly name: string; readonly kind: StageKind }[] | string | null;
  readonly startOn: StartScreen;
  /** Every Extra, on unless switched off. */
  readonly extras: ExtraSwitches;
  /** An IANA zone name, or null for the Worker's own. */
  readonly timeZone: string | null;
  /** Where the account is in full encryption. Read here; only the encryption routes change it. */
  readonly encryption: EncryptionState;
}

/** A change to the settings: a level name or an Extra may be sent alone, and null puts a name back. */
export type AccountSettingsChange =
  & Partial<Omit<AccountSettings, "levelNames" | "extras" | "encryption">>
  & {
    readonly levelNames?: { readonly [K in keyof AccountLevelNames]?: string | null };
    readonly extras?: Partial<ExtraSwitches>;
  };

const LEVELS = ["space", "project", "milestone", "task"] as const;
const SHIPPED_NAMES: AccountLevelNames = { space: "Space", project: "Project", milestone: "Milestone", task: "Task" };

/** What a settings change comes to: the whole new settings, and what each column will hold. */
interface SettingsPlan {
  readonly next: AccountSettings;
  readonly levelColumns: (string | null)[];
  readonly extras: Partial<ExtraSwitches>;
}

/** Lays a change over the stored row. A level name sent replaces it, null puts it back, the rest stay. */
function planSettings(row: Row, change: AccountSettingsChange): SettingsPlan {
  const levelColumns = LEVELS.map((level) =>
    change.levelNames !== undefined && level in change.levelNames
      ? (change.levelNames[level] ?? null)
      : optStr(row[`level_${level}`]));
  const extras = { ...storedExtras(row.extras), ...change.extras };
  const { levelNames: _names, extras: _extras, ...plain } = change;
  const next: AccountSettings = {
    ...appearanceFrom(row), ...plain,
    levelNames: levelNamesOf({
      level_space: levelColumns[0], level_project: levelColumns[1], level_milestone: levelColumns[2], level_task: levelColumns[3],
    }),
    extras: extrasOf(extras),
  };
  return { next, levelColumns, extras };
}

const SETTINGS_COLUMNS =
  "accent, spacing, theme, map_style, new_task_venture_id, last_review_on, remind_morning, remind_tasks, quiet_from, quiet_to, " +
  "level_space, level_project, level_milestone, level_task, default_stages, start_on, extras, time_zone, encryption";

/** The stored JSON of one column, or null when it is empty or is not what this build wrote. */
function storedJson(v: unknown): unknown {
  if (typeof v !== "string") return null;
  try { return JSON.parse(v) as unknown; } catch { return null; }
}

function storedStages(v: unknown): AccountProfile["defaultStages"] {
  if (typeof v === "string" && isEnvelopeShape(v)) return v;
  const list = storedJson(v);
  if (!Array.isArray(list)) return null;
  const out: { name: string; kind: StageKind }[] = [];
  for (const item of list) {
    const { name, kind } = (typeof item === "object" && item !== null ? item : {}) as { name?: unknown; kind?: unknown };
    if (typeof name !== "string" || !(STAGE_KINDS as readonly unknown[]).includes(kind)) return null;
    out.push({ name, kind: kind as StageKind });
  }
  return out.length === 0 ? null : out;
}

/** Only the switches a person set are stored; one never named is on. */
function storedExtras(v: unknown): Partial<ExtraSwitches> {
  const object = storedJson(v);
  const out: { -readonly [K in keyof ExtraSwitches]?: boolean } = {};
  if (typeof object !== "object" || object === null) return out;
  for (const key of EXTRA_SWITCHES) {
    const given = (object as Record<string, unknown>)[key];
    if (typeof given === "boolean") out[key] = given;
  }
  return out;
}

const extrasOf = (stored: Partial<ExtraSwitches>): ExtraSwitches => ({
  smartDates: stored.smartDates ?? true, singleKeys: stored.singleKeys ?? true, recent: stored.recent ?? true,
  rings: stored.rings ?? true, comingUp: stored.comingUp ?? true, burst: stored.burst ?? true,
});

const levelNamesOf = (r: Row): AccountLevelNames => {
  const named = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback);
  return {
    space: named(r.level_space, SHIPPED_NAMES.space), project: named(r.level_project, SHIPPED_NAMES.project),
    milestone: named(r.level_milestone, SHIPPED_NAMES.milestone), task: named(r.level_task, SHIPPED_NAMES.task),
  };
};

/** A stored value this build does not know falls back to the default rather than throwing. */
const appearanceFrom = (r: Row): AccountSettings => ({
  accent: isAccent(r.accent) ? r.accent : DEFAULT_APPEARANCE.accent,
  spacing: isSpacing(r.spacing) ? r.spacing : DEFAULT_APPEARANCE.spacing,
  theme: isThemeMode(r.theme) ? r.theme : DEFAULT_APPEARANCE.theme,
  mapStyle: isMapStyle(r.map_style) ? r.map_style : DEFAULT_APPEARANCE.mapStyle,
  newTaskVentureId: typeof r.new_task_venture_id === "string" ? r.new_task_venture_id : null,
  lastReviewOn: typeof r.last_review_on === "string" ? r.last_review_on : null,
  morningAt: typeof r.remind_morning === "string" ? r.remind_morning : null,
  taskReminders: num(r.remind_tasks) === 1,
  quietFrom: typeof r.quiet_from === "string" ? r.quiet_from : null,
  quietTo: typeof r.quiet_to === "string" ? r.quiet_to : null,
  levelNames: levelNamesOf(r),
  defaultStages: storedStages(r.default_stages),
  startOn: (START_SCREENS as readonly unknown[]).includes(r.start_on) ? (r.start_on as StartScreen) : "map",
  extras: extrasOf(storedExtras(r.extras)),
  timeZone: typeof r.time_zone === "string" && r.time_zone !== "" ? r.time_zone : null,
  encryption: encryptionOf(r.encryption),
});

const ENCRYPTION_STATES: readonly EncryptionState[] = ["off", "turning_on", "on", "turning_off"];
const encryptionOf = (v: unknown): EncryptionState => (ENCRYPTION_STATES as readonly unknown[]).includes(v) ? (v as EncryptionState) : "off";

const NO_SETTINGS: AccountSettings = {
  ...DEFAULT_APPEARANCE, newTaskVentureId: null, lastReviewOn: null,
  morningAt: null, taskReminders: false, quietFrom: null, quietTo: null,
  levelNames: SHIPPED_NAMES, defaultStages: null, startOn: "map", extras: extrasOf({}), timeZone: null, encryption: "off",
};

const subscriptionFrom = (r: Row): PushSubscriptionSummary => ({
  id: str(r.id), endpoint: str(r.endpoint),
  label: typeof r.label === "string" ? r.label : null, tz: str(r.tz), createdAt: str(r.created_at),
  lastOkAt: typeof r.last_ok_at === "string" ? r.last_ok_at : null,
});

const tokenFrom = (r: Row): EmailToken => ({
  id: str(r.id), owner: str(r.owner), purpose: str(r.purpose) as TokenPurpose,
  email: str(r.email), expiresAt: str(r.expires_at),
});

const normalEmail =(email: string): string => email.trim().toLowerCase();
const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");
const isUnique = (e: unknown): boolean => e instanceof Error && e.message.includes("UNIQUE constraint failed");

const escapeLike = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

const SESSION_ROW = `SELECT session_generation FROM account WHERE id = ?`;
const sessionState = (row: Row | null, generation: number): SessionState =>
  row === null ? "gone" : num(row.session_generation) === generation ? "open" : "ended";
/** Where a statement `readingAs` hands out keeps the binding's own. */
const REAL = Symbol("real statement");

// ---------------------------------------------------------------------------

class D1Store implements Store {
  constructor(
    private readonly db: D1Database,
    private readonly clock: () => Date,
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  private async one(sql: string, ...binds: unknown[]): Promise<Row | null> {
    return this.db.prepare(sql).bind(...binds).first<Row>();
  }

  // -- read paths ----------------------------------------------------------

  async overview(owner: string): Promise<Overview> {
    const nextOf = (where: string): string =>
      `(SELECT json_object('id', om.id, 'name', om.name, 'aimingOn', om.aiming_on) FROM open_milestones om` +
      ` JOIN vis c ON c.id = om.venture_id WHERE ${where}` +
      ` ORDER BY om.aiming_on IS NULL, om.aiming_on, om.project_position, om.position LIMIT 1)`;
    const sumOf = (field: string, where: string): string =>
      `(SELECT COALESCE(SUM(tf.${field}), 0) FROM task_figures tf JOIN vis c ON c.id = tf.venture_id WHERE ${where})`;
    const own = "c.id = g.id";
    const total = "(c.id = g.id OR c.parent_id = g.id)";

    const figures = this.db.prepare(
      `WITH vis AS (
         SELECT x.id, x.name, x.icon, x.description, x.parent_id, x.position, x.created_at
         FROM venture x WHERE x.owner = ?1 AND ${ventureVisible("x")}
       ),
       task_figures AS (
         SELECT t.venture_id,
           SUM(s.kind IS NOT NULL AND s.kind = 'underway') AS underway,
           SUM(EXISTS (SELECT 1 FROM blocker b WHERE b.task_id = t.id AND b.archived_at IS NULL)
             AND ${NOT_FINISHED("s.kind")}) AS blocked,
           SUM(${NOT_FINISHED("s.kind")}) AS tasks_left
         FROM task t LEFT JOIN state s ON s.id = t.state_id
         WHERE t.owner = ?1 AND ${taskVisible("t")}
         GROUP BY t.venture_id
       ),
       open_milestones AS (
         SELECT p.venture_id, m.id, m.name, m.aiming_on, m.position, p.position AS project_position
         FROM milestone m JOIN project p ON p.id = m.project_id LEFT JOIN state s ON s.id = m.state_id
         WHERE m.owner = ?1 AND ${milestoneVisible("m")} AND ${NOT_FINISHED("s.kind")}
       )
       SELECT g.id, g.name, g.icon, g.description, g.parent_id, g.position,
         ${sumOf("underway", own)} AS own_underway,
         ${sumOf("blocked", own)} AS own_blocked,
         ${sumOf("tasks_left", own)} AS own_tasks_left,
         ${nextOf(own)} AS own_next,
         ${sumOf("underway", total)} AS total_underway,
         ${sumOf("blocked", total)} AS total_blocked,
         ${sumOf("tasks_left", total)} AS total_tasks_left,
         ${nextOf(total)} AS total_next
       FROM vis g
       ORDER BY g.position, g.created_at`,
    ).bind(owner);

    // Its own statement: `figures` has no row when no venture is visible, which is exactly
    // when a count of archived ones matters. Still one round trip in the same batch.
    const archivedCount = this.db.prepare(
      `SELECT COUNT(*) AS n FROM venture WHERE owner = ?1 AND archived_at IS NOT NULL`,
    ).bind(owner);

    const [figureRows, archivedRows] = await this.db.batch<Row>([figures, archivedCount]);
    const figuresFrom = (r: Row, prefix: "own" | "total"): Figures => ({
      underway: num(r[`${prefix}_underway`]),
      blocked: num(r[`${prefix}_blocked`]),
      tasksLeft: num(r[`${prefix}_tasks_left`]),
      nextMilestone: parseJson<NextMilestone>(r[`${prefix}_next`]),
    });
    const ventures: OverviewVenture[] = (figureRows?.results ?? []).map((r) => ({
      id: str(r.id), name: str(r.name), icon: optStr(r.icon), description: optStr(r.description),
      parentId: optStr(r.parent_id), position: num(r.position),
      own: figuresFrom(r, "own"), total: figuresFrom(r, "total"),
    }));
    return {
      ventures,
      archivedVentures: num(archivedRows?.results?.[0]?.n),
    };
  }

  async tree(owner: string): Promise<Tree> {
    const select = (kind: Kind, extra = ""): D1PreparedStatement =>
      this.db.prepare(
        `SELECT x.*${extra} FROM ${TABLE[kind]} x WHERE x.owner = ? AND ${VISIBLE[kind]("x")} ORDER BY ${ORDER[kind]("x")}`,
      ).bind(owner);
    const [v, s, g, p, m, t] = await this.db.batch<Row>([
      select("ventures"), select("states"), select("stages"), select("projects", `, ${TAG_IDS("projectTags", "x")} AS tag_ids`),
      select("milestones"),
      select("tasks", `, ${BLOCKER_JSON("x")} AS blocker_json, ${TAG_IDS("taskTags", "x")} AS tag_ids,` +
        ` (SELECT xs.kind FROM state xs WHERE xs.id = x.state_id) AS state_kind`),
    ]);

    const taskRows = t?.results ?? [];
    const tasks = taskRows.map(withBlocker);
    // A finished task keeps its blocker as a record of what held it up, but nothing waits on
    // it any more, so it does not make anything above it read as blocked.
    const finished = new Set(taskRows.filter((r) => r.state_kind === "finished").map((r) => str(r.id)));
    const blockedTask = (task: TaskWithBlocker): boolean => task.blocker !== null && !finished.has(task.id);
    const ventures = (v?.results ?? []).map(MAP.ventures);
    const tagged = (p?.results ?? []).map((r) => ({ ...MAP.projects(r), tagIds: tagIdsOf(r) }));
    // Everything is grouped once, in the order it came, so the tree costs one pass over each
    // table rather than a pass over every table for every space and project in it.
    const group = <T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> => {
      const out = new Map<K, T[]>();
      for (const item of items) {
        const k = key(item);
        const list = out.get(k);
        if (list === undefined) out.set(k, [item]);
        else list.push(item);
      }
      return out;
    };
    const none: never[] = [];
    const childVentures = group(ventures, (c) => c.parentId);
    const childProjects = group(tagged, (c) => c.parentId);
    const projectsOf = group(tagged, (p) => p.ventureId);
    const milestonesOf = group((m?.results ?? []).map(MAP.milestones), (x) => x.projectId);
    const statesOf = group((s?.results ?? []).map(MAP.states), (x) => x.ventureId);
    const stagesOf = group((g?.results ?? []).map(MAP.stages), (x) => x.ventureId);
    const tasksOfProject = group(tasks.filter((x) => x.projectId !== null), (x) => x.projectId);
    const looseOf = group(tasks.filter((x) => x.projectId === null), (x) => x.ventureId);
    const blockedTasks = tasks.filter(blockedTask);
    const blockedInVenture = new Set(blockedTasks.map((x) => x.ventureId));
    const blockedInProject = new Set(blockedTasks.flatMap((x) => (x.projectId === null ? [] : [x.projectId])));
    const blockedAtMilestone = new Set(blockedTasks.flatMap((x) => (x.projectId === null || x.milestoneId === null ? [] : [`${x.projectId}|${x.milestoneId}`])));

    const tree: TreeVenture[] = ventures.map((venture) => {
      const projects: TreeProject[] = (projectsOf.get(venture.id) ?? none).map((project) => {
        // A project that holds projects reads as blocked when anything inside one is, as a
        // venture does. Its own `tasks` stay its own.
        const nest = [project.id, ...(childProjects.get(project.id) ?? none).map((c) => c.id)];
        return {
          ...project,
          blocked: nest.some((id) => blockedInProject.has(id)),
          milestones: (milestonesOf.get(project.id) ?? none).map((milestone) => ({
            ...milestone,
            blocked: blockedAtMilestone.has(`${project.id}|${milestone.id}`),
          })),
          tasks: tasksOfProject.get(project.id) ?? [],
        };
      });
      const beneath = [venture.id, ...(childVentures.get(venture.id) ?? none).map((c) => c.id)];
      return {
        ...venture,
        blocked: beneath.some((id) => blockedInVenture.has(id)),
        states: statesOf.get(venture.id) ?? [],
        stages: stagesOf.get(venture.id) ?? [],
        projects,
        tasks: looseOf.get(venture.id) ?? [],
      };
    });
    return { ventures: tree };
  }

  async today(owner: string, on: string): Promise<Today> {
    // The one statement in the tree that compares a date with today, and it reads a task's
    // own due date. A milestone's date is never compared with anything.
    //
    // Decision 23: the picked list has an order of its own. A task that has never been
    // moved by hand has no `today_position` and falls in behind those that have one, in
    // the order it had before, so turning the feature on rearranges nothing.
    const rows = await this.db.prepare(
      `SELECT t.*, s.kind AS state_kind, ${BLOCKER_JSON("t")} AS blocker_json,
         ${TAG_IDS("taskTags", "t")} AS tag_ids,
         (t.picked_on IS NOT NULL AND t.picked_on = ?2) AS picked,
         (t.due_on IS NOT NULL AND t.due_on < ?2 AND ${NOT_FINISHED("s.kind")}) AS overdue
       FROM task t LEFT JOIN state s ON s.id = t.state_id
       WHERE t.owner = ?1 AND ${taskVisible("t")}
         AND (t.picked_on = ?2 OR (t.due_on < ?2 AND ${NOT_FINISHED("s.kind")}))
       ORDER BY picked DESC, t.today_position IS NULL, t.today_position,
         t.due_on IS NULL, t.due_on, t.position, t.created_at`,
    ).bind(owner, on).all<Row>();
    const tasks: TodayTask[] = rows.results.map((r) => ({
      ...withBlocker(r),
      stateKind: optStr(r.state_kind) as StateKind | null,
      picked: num(r.picked) === 1,
      overdue: num(r.overdue) === 1,
    }));
    return { on, tasks };
  }

  async dateFilters(owner: string, on: string): Promise<DateFilters> {
    // Beside today(): a task's own due date against the day, and nothing else. The week runs
    // from `on` to the coming Sunday; a Sunday is its own week's end.
    const [y, m, d] = on.split("-").map(Number) as [number, number, number];
    const at = Date.UTC(y, m - 1, d);
    const sunday = new Date(at + ((7 - new Date(at).getUTCDay()) % 7) * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db.prepare(
      `SELECT t.* FROM task t LEFT JOIN state s ON s.id = t.state_id
       WHERE t.owner = ?1 AND ${taskVisible("t")} AND ${NOT_FINISHED("s.kind")}
         AND t.due_on IS NOT NULL AND t.due_on <= ?2
       ORDER BY t.due_on, t.position, t.created_at`,
    ).bind(owner, sunday).all<Row>();
    const tasks = rows.results.map(MAP.tasks);
    return {
      on,
      before: tasks.filter((t) => (t.dueOn as string) < on),
      week: tasks.filter((t) => (t.dueOn as string) >= on),
    };
  }

  async search(owner: string, q: string): Promise<SearchHit[]> {
    const needle = q.trim();
    if (needle === "") return [];
    const escaped = escapeLike(needle);
    // One statement a kind in one batch, each with its own allowance (SEARCH_MOST), so a word
    // in fifty task titles cannot crowd out the venture of that name. D1 caps the terms in a
    // compound SELECT, so a UNION of eight is refused; a batch is the same round trip. Within a
    // kind the order is fixed: a match where the words start before one in their middle, then
    // A to Z. Nothing scores the work.
    const has = (col: string): string => `${col} LIKE ?2 ESCAPE '\\'`;
    const starts = (col: string): string => `${col} LIKE ?3 ESCAPE '\\'`;
    // A locked field is ciphertext: it never matches, whatever is typed.
    const plain = (col: string): string => `(${has(col)} AND NOT ${sealedSql(col)})`;
    const step = `EXISTS (SELECT 1 FROM json_each(x.checklist) c WHERE ${has("json_extract(c.value, '$.text')")})`;
    const text: Record<SearchKind, string> = {
      venture: "x.name", project: "x.name", milestone: "x.name", task: "x.title",
      decision: "x.title", risk: "x.title", note: "x.body", link: "COALESCE(x.label, x.url)",
    };
    const from: Record<SearchKind, { table: string; venture: string; project: string; task: string; visible: string; matches: string }> = {
      venture: { table: "venture", venture: "x.id", project: "NULL", task: "NULL", visible: ventureVisible("x"), matches: has("x.name") },
      // A project is found by its name or its brief, and listed by its name. The order puts a
      // name match first because it sorts on the name alone.
      project: {
        table: "project", venture: "x.venture_id", project: "x.id", task: "NULL", visible: projectVisible("x"),
        matches: `(${has("x.name")} OR ${plain("x.description")} OR ${plain("x.who_for")} OR ${plain("x.done_looks")} OR ${plain("x.open_questions")})`,
      },
      milestone: {
        table: "milestone", venture: VENTURE_OF.milestones("x"), project: "x.project_id", task: "NULL",
        visible: milestoneVisible("x"), matches: has("x.name"),
      },
      // A task is found by its title, its body or any of its steps, and listed by its title.
      task: {
        table: "task", venture: "x.venture_id", project: "x.project_id", task: "x.id", visible: taskVisible("x"),
        matches: `(${has("x.title")} OR ${plain("x.body")} OR ${step})`,
      },
      decision: {
        table: "decision", venture: VENTURE_OF.decisions("x"), project: "x.project_id", task: "NULL",
        visible: VISIBLE.decisions("x"), matches: `(${has("x.title")} OR ${has("x.body")})`,
      },
      risk: {
        table: "risk", venture: VENTURE_OF.risks("x"), project: "x.project_id", task: "NULL",
        visible: VISIBLE.risks("x"), matches: `(${has("x.title")} OR ${has("x.body")})`,
      },
      note: {
        table: "note", venture: VENTURE_OF.notes("x"), project: "x.project_id",
        task: "NULL", visible: VISIBLE.notes("x"), matches: plain("x.body"),
      },
      link: {
        table: "link", venture: VENTURE_OF.links("x"), project: "x.project_id", task: "x.task_id",
        visible: VISIBLE.links("x"), matches: `(${has("x.url")} OR ${has("x.label")})`,
      },
    };
    // What is listed is what the archive lists: a note is cut as its label is. It is still
    // ordered by its whole body, so a match past the cut ranks as the match it is.
    const shown = (kind: SearchKind): string => (kind === "note" ? LABEL.notes : text[kind]);
    const searches = SEARCH_KINDS.map((kind) => {
      const k = from[kind];
      return this.db.prepare(
        `SELECT x.id, ${k.venture} AS venture_id, ${k.project} AS project_id, ${k.task} AS task_id, ${shown(kind)} AS text
         FROM ${k.table} x
         WHERE x.owner = ?1 AND ${k.visible} AND ${k.matches}
         ORDER BY ${has(text[kind])} DESC, ${starts(text[kind])} DESC, ${text[kind]} COLLATE NOCASE, x.id
         LIMIT ${SEARCH_MOST[kind]}`,
      ).bind(owner, `%${escaped}%`, `${escaped}%`);
    });
    // A fully encrypted account is searched on its devices: everything here is ciphertext. The
    // state rides in the same round trip.
    const results = await this.db.batch<Row>([...searches, this.db.prepare(`SELECT encryption FROM account WHERE id = ?`).bind(owner)]);
    if (results[SEARCH_KINDS.length]?.results[0]?.encryption === "on") return [];
    return SEARCH_KINDS.flatMap((kind, i) => (results[i]?.results ?? []).map((r): SearchHit => ({
      kind, id: str(r.id), ventureId: str(r.venture_id), projectId: optStr(r.project_id), taskId: optStr(r.task_id), text: str(r.text),
    })));
  }

  async archived(owner: string): Promise<ArchivedItem[]> {
    // One statement per table in one batch. D1 caps the terms in a compound SELECT well
    // below ten, so a UNION across every table is refused; a batch is the same round trip.
    const kinds = Object.keys(TABLE) as Kind[];
    // A project also says which projects are inside it, so a restore can say what it waits on.
    const holds = (kind: Kind): string => kind === "projects"
      ? `, (SELECT json_group_array(c.id) FROM project c WHERE c.parent_id = x.id AND c.owner = ?1) AS holds`
      : "";
    const results = await this.db.batch<Row>(kinds.map((kind) => this.db.prepare(
      `SELECT x.id, ${LABEL[kind]} AS label, x.archived_at${holds(kind)} FROM ${TABLE[kind]} x WHERE x.owner = ?1 AND x.archived_at IS NOT NULL`,
    ).bind(owner)));
    return kinds
      .flatMap((kind, n) => (results[n]?.results ?? []).map((r): ArchivedItem => ({
        kind, id: str(r.id), label: str(r.label), archivedAt: str(r.archived_at),
        ...(kind === "projects" ? { holds: parseJson<string[]>(r.holds) ?? [] } : {}),
      })))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  async locked(owner: string): Promise<LockedField[]> {
    const kinds = Object.keys(LOCKED_COLUMNS) as (keyof typeof LOCKED_COLUMNS)[];
    const parts = kinds.flatMap((kind) => LOCKED_COLUMNS[kind].columns.map(([column, field]) => {
      const { table } = LOCKED_COLUMNS[kind];
      const project = kind === "projects" ? "x.id" : "x.project_id";
      const task = kind === "tasks" ? "x.id" : "NULL";
      return this.db.prepare(
        `SELECT '${kind}' AS kind, x.id, '${field}' AS field, x.${column} AS value, ${VENTURE_OF[kind](
          "x")} AS venture_id, ${project} AS project_id, ${task} AS task_id
         FROM ${table} x WHERE x.owner = ?1 AND ${VISIBLE[kind]("x")} AND ${sealedSql(`x.${column}`)}
         ORDER BY x.id`,
      ).bind(owner);
    }));
    const results = await this.db.batch<Row>(parts);
    return results.flatMap((r) => (r.results ?? []).map((row): LockedField => ({
      kind: str(row.kind) as LockedField["kind"], id: str(row.id), field: str(row.field), value: str(row.value),
      ventureId: str(row.venture_id), projectId: optStr(row.project_id), taskId: optStr(row.task_id),
    })));
  }

  // -- records -------------------------------------------------------------

  async list<K extends Kind>(owner: string, kind: K, filter: Readonly<Record<string, string>>): Promise<Outcome<Records[K][]>> {
    const clauses: string[] = [];
    const binds: unknown[] = [owner];
    for (const [key, value] of Object.entries(filter)) {
      const fragment = FILTERS[kind][key];
      if (fragment === undefined) return { ok: false, status: 400, error: `${kind} cannot be filtered by ${key}` };
      clauses.push(` AND ${fragment("x")}`);
      binds.push(value);
    }
    const rows = await this.db.prepare(
      `SELECT x.* FROM ${TABLE[kind]} x WHERE x.owner = ? AND ${VISIBLE[kind]("x")}${clauses.join("")} ORDER BY ${ORDER[kind]("x")}`,
    ).bind(...binds).all<Row>();
    const map = MAP[kind] as (r: Row) => Records[K];
    return { ok: true, value: rows.results.map(map) };
  }

  async get<K extends Kind>(owner: string, kind: K, id: string): Promise<Records[K] | null> {
    const row = await this.one(`SELECT * FROM ${TABLE[kind]} WHERE id = ? AND owner = ?`, id, owner);
    return row === null ? null : (MAP[kind] as (r: Row) => Records[K])(row);
  }

  async create<K extends Kind>(owner: string, kind: K, input: CreateInput[K] & ClientId): Promise<Outcome<Written<Records[K]>>> {
    const { id, ...fields } = input;
    const sealed = await this.plainRefused(owner, kind, fields);
    if (sealed !== null) return sealed;
    if (id !== undefined) {
      const earlier = await this.madeBefore(owner, kind, id);
      if (earlier !== null) return earlier;
    }
    try {
      return await this.createUnguarded(owner, kind, fields as CreateInput[K], id ?? crypto.randomUUID());
    } catch (e) {
      // Two copies of one create can pass the check above together; the loser meets the
      // primary key, and is answered with the winner's record like any other repeat.
      if (id !== undefined) {
        const earlier = await this.madeBefore(owner, kind, id);
        if (earlier !== null) return earlier;
      }
      return constraintOutcome(e);
    }
  }

  /**
   * The record a client-chosen id already names, or null when the id is unused. Ids are
   * looked for in every record's table (`TABLE`), so one id never names two records for a
   * client that keys its cache by id alone. The tag edges (`EDGE_TABLE`) are not looked in:
   * an edge's id is made here by `crypto.randomUUID()` and never leaves the Worker, so no
   * client can hold one to send.
   */
  private async madeBefore<K extends Kind>(owner: string, kind: K, id: string): Promise<Outcome<Written<Records[K]>> | null> {
    const kinds = Object.keys(TABLE) as Kind[];
    const owners = await this.one(
      `SELECT ${kinds.map((k, n) => `(SELECT owner FROM ${TABLE[k]} WHERE id = ?1) AS o${n}`).join(", ")}`, id,
    );
    const taken = kinds.filter((_, n) => owners?.[`o${n}`] !== null && owners?.[`o${n}`] !== undefined);
    if (taken.length === 0) return null;
    if (taken.length > 1 || taken[0] !== kind || owners?.[`o${kinds.indexOf(kind)}`] !== owner) {
      return { ok: false, status: 409, error: `id ${id} is already used by something else` };
    }
    const row = await this.one(
      `SELECT x.*, ${VENTURE_OF[kind]("x")} AS venture_of FROM ${TABLE[kind]} x WHERE x.id = ? AND x.owner = ?`, id, owner,
    );
    if (row === null) return { ok: false, status: 409, error: `id ${id} is already used by something else` };
    return {
      ok: true,
      value: { record: (MAP[kind] as (r: Row) => Records[K])(row), ventureId: optStr(row.venture_of), replayed: true },
    };
  }

  async update<K extends Kind>(owner: string, kind: K, id: string, patch: PatchInput[K], today?: string): Promise<Outcome<Written<Records[K]>>> {
    const sealed = await this.plainRefused(owner, kind, patch);
    if (sealed !== null) return sealed;
    try {
      return await this.updateUnguarded(owner, kind, id, patch, today);
    } catch (e) {
      return constraintOutcome(e);
    }
  }

  async actOnReminder(owner: string, taskId: string, action: ReminderAction, at: string, today?: string): Promise<Outcome<Written<Task>>> {
    const row = await this.one(`SELECT venture_id FROM task WHERE id = ? AND owner = ? AND archived_at IS NULL`, taskId, owner);
    if (row === null) return { ok: false, status: 404, error: `tasks ${taskId} was not found` };
    if (action === "snooze") return this.update(owner, "tasks", taskId, { remindAt: oneHourOn(at) }, today);
    const done = await this.one(
      `SELECT id FROM state WHERE venture_id = ? AND owner = ? AND kind = 'finished' AND archived_at IS NULL ORDER BY position, created_at LIMIT 1`,
      str(row.venture_id), owner,
    );
    if (done === null) return { ok: false, status: 404, error: "this space has no finished state" };
    return this.update(owner, "tasks", taskId, { stateId: str(done.id) }, today);
  }

  async setArchived<K extends Kind>(owner: string, kind: K, id: string, archived: boolean): Promise<Outcome<Written<Records[K]>>> {
    try {
      const current = await this.one(`SELECT * FROM ${TABLE[kind]} WHERE id = ? AND owner = ?`, id, owner);
      if (current === null) return { ok: false, status: 404, error: `${kind} ${id} was not found` };
      const rules: Rule[] = [];
      if (archived && kind === "states") {
        rules.push(rule(
          `NOT EXISTS (SELECT 1 FROM task r WHERE r.state_id = ? AND r.archived_at IS NULL)` +
          ` AND NOT EXISTS (SELECT 1 FROM milestone r WHERE r.state_id = ? AND r.archived_at IS NULL)`,
          [id, id], 409, "tasks or milestones sit in this state: move them to another state first"));
      }
      if (archived && kind === "stages") {
        rules.push(rule(
          `NOT EXISTS (SELECT 1 FROM venture r WHERE r.stage_id = ? AND r.archived_at IS NULL)` +
          ` AND NOT EXISTS (SELECT 1 FROM project r WHERE r.stage_id = ? AND r.archived_at IS NULL)`,
          [id, id], 409, "a venture or project sits at this stage: move it to another stage first"));
      }
      if (!archived && kind === "blockers") {
        rules.push(rule(
          `NOT EXISTS (SELECT 1 FROM blocker r WHERE r.task_id = ? AND r.id <> ? AND r.archived_at IS NULL)`,
          [current.task_id, id], 409, "that task already carries another blocker"));
      }
      if (!archived && kind === "tags") {
        // The unique index would refuse this too, but namelessly. Restoring several things
        // at once can meet it for one of twenty, and the refusal has to say which to rename.
        const name = str(current.name);
        rules.push(rule(
          `NOT EXISTS (SELECT 1 FROM tag r WHERE r.owner = ? AND r.name = ? AND r.id <> ? AND r.archived_at IS NULL)`,
          [owner, name, id], 409, `the tag "${name}" cannot come back while another tag is called "${name}": rename one of them first`));
      }
      const at = this.now();
      const sets: Col[] = archived ? [["archived_at", "COALESCE(archived_at, ?)", [at]]] : [["archived_at", "NULL", []]];
      const extra: D1PreparedStatement[] = [];
      if (archived && kind === "milestones") {
        // A milestone is a dated checkpoint, not a container for work. Archiving a reached one
        // would otherwise hide every task still pointing at it, open ones included, with no
        // sign of them in the archive. Its tasks stay in the project instead.
        extra.push(this.db.prepare(
          `UPDATE task SET milestone_id = NULL, updated_at = ?1
           WHERE task.milestone_id = ?2 AND task.owner = ?3
             AND EXISTS (SELECT 1 FROM milestone am WHERE am.id = ?2 AND am.archived_at IS NOT NULL)`,
        ).bind(at, id, owner));
      }
      return await this.write(kind, id, this.updateStatement(kind, owner, id, sets, rules, at), rules, extra);
    } catch (e) {
      return constraintOutcome(e);
    }
  }

  // -- deleting, decision 33 -----------------------------------------------

  /**
   * Which rows a delete takes with it, as a SELECT per table.
   *
   * Every fragment is a condition on that table's alias `x`, parameterless except for the
   * two binds every statement here takes: `?1` the id, `?2` the owner. A kind that takes
   * nothing else with it answers `null` for that table.
   *
   * The tag edges are here on the same terms as every other table, even though neither is a
   * kind: `task_tag` and `project_tag` hold rows about a task, a project and a tag, so when
   * any of those three goes, the rows that name it go with it.
   */
  private cascade(kind: Kind): Readonly<Partial<Record<Kind | Edge, string>>> {
    const tasksOfVenture = `x.venture_id = ?1`;
    const projectsOfVenture = `x.venture_id = ?1`;
    // A decision or a risk on the venture itself, and one on any of its projects.
    const ledgerOfVenture =
      `x.venture_id = ?1 OR EXISTS (SELECT 1 FROM project p WHERE p.id = x.project_id AND p.venture_id = ?1)`;
    // The project itself and the projects inside it.
    const inNest = (column: string): string =>
      `${column} IN (SELECT n.id FROM project n WHERE n.id = ?1 OR n.parent_id = ?1)`;
    switch (kind) {
      case "ventures": return {
        tasks: tasksOfVenture,
        projects: projectsOfVenture,
        states: `x.venture_id = ?1`,
        stages: `x.venture_id = ?1`,
        milestones: `EXISTS (SELECT 1 FROM project p WHERE p.id = x.project_id AND p.venture_id = ?1)`,
        blockers: `EXISTS (SELECT 1 FROM task t WHERE t.id = x.task_id AND t.venture_id = ?1)`,
        links:
          `x.venture_id = ?1` +
          ` OR EXISTS (SELECT 1 FROM project p WHERE p.id = x.project_id AND p.venture_id = ?1)` +
          ` OR EXISTS (SELECT 1 FROM task t WHERE t.id = x.task_id AND t.venture_id = ?1)`,
        notes:
          `x.venture_id = ?1` +
          ` OR EXISTS (SELECT 1 FROM project p WHERE p.id = x.project_id AND p.venture_id = ?1)` +
          ` OR EXISTS (SELECT 1 FROM milestone m JOIN project mp ON mp.id = m.project_id WHERE m.id = x.milestone_id AND mp.venture_id = ?1)` +
          ` OR EXISTS (SELECT 1 FROM task t WHERE t.id = x.task_id AND t.venture_id = ?1)`,
        decisions: ledgerOfVenture,
        risks: ledgerOfVenture,
        taskTags: `EXISTS (SELECT 1 FROM task t WHERE t.id = x.task_id AND t.venture_id = ?1)`,
        projectTags: `EXISTS (SELECT 1 FROM project p WHERE p.id = x.project_id AND p.venture_id = ?1)`,
      };
      // A project takes the projects inside it, and everything under them, with it.
      case "projects": return {
        projects: `x.parent_id = ?1`,
        tasks: inNest("x.project_id"),
        milestones: inNest("x.project_id"),
        blockers: `EXISTS (SELECT 1 FROM task t WHERE t.id = x.task_id AND ${inNest("t.project_id")})`,
        links:
          inNest("x.project_id") +
          ` OR EXISTS (SELECT 1 FROM task t WHERE t.id = x.task_id AND ${inNest("t.project_id")})`,
        notes:
          inNest("x.project_id") +
          ` OR EXISTS (SELECT 1 FROM milestone m WHERE m.id = x.milestone_id AND ${inNest("m.project_id")})` +
          ` OR EXISTS (SELECT 1 FROM task t WHERE t.id = x.task_id AND ${inNest("t.project_id")})`,
        decisions: inNest("x.project_id"),
        risks: inNest("x.project_id"),
        taskTags: `EXISTS (SELECT 1 FROM task t WHERE t.id = x.task_id AND ${inNest("t.project_id")})`,
        projectTags: inNest("x.project_id"),
      };
      // A milestone is a checkpoint, not a container: its tasks are let go of, as archiving
      // one already does, rather than destroyed with it.
      case "milestones": return { notes: `x.milestone_id = ?1` };
      case "tasks": return {
        blockers: `x.task_id = ?1`, links: `x.task_id = ?1`, notes: `x.task_id = ?1`,
        taskTags: `x.task_id = ?1`,
      };
      // Deleting a tag takes its assignments with it and leaves every task and project it
      // was on. The tag itself is never removed for being on nothing: it is listed, and it
      // goes when it is archived and then deleted, like everything else.
      case "tags": return { taskTags: `x.tag_id = ?1`, projectTags: `x.tag_id = ?1` };
      default: return {};
    }
  }

  /**
   * Rows that are not deleted but point at something that is, and the column to clear.
   *
   * A blocker in another venture that waits on a deleted task is kept, with its reason: it
   * belongs to a task the person did not name, and destroying it would be the thing decision
   * 33 refuses for an owned venture, in a quieter place.
   */
  private detachments(kind: Kind): readonly { readonly table: string; readonly column: string; readonly where: string }[] {
    const of = (table: string, column: string, where: string) => ({ table, column, where });
    switch (kind) {
      case "ventures": return [
        of("blocker", "waits_on_task_id", `EXISTS (SELECT 1 FROM task t WHERE t.id = x.waits_on_task_id AND t.venture_id = ?1)`),
        of("task", "state_id", `EXISTS (SELECT 1 FROM state s WHERE s.id = x.state_id AND s.venture_id = ?1)`),
        of("milestone", "state_id", `EXISTS (SELECT 1 FROM state s WHERE s.id = x.state_id AND s.venture_id = ?1)`),
        of("task", "milestone_id", `EXISTS (SELECT 1 FROM milestone m JOIN project p ON p.id = m.project_id WHERE m.id = x.milestone_id AND p.venture_id = ?1)`),
        of("venture", "stage_id", `x.id = ?1`),
        of("project", "stage_id", `EXISTS (SELECT 1 FROM stage g WHERE g.id = x.stage_id AND g.venture_id = ?1)`),
      ];
      case "projects": {
        const inNest = (column: string): string =>
          `${column} IN (SELECT n.id FROM project n WHERE n.id = ?1 OR n.parent_id = ?1)`;
        return [
          of("blocker", "waits_on_task_id", `EXISTS (SELECT 1 FROM task t WHERE t.id = x.waits_on_task_id AND ${inNest("t.project_id")})`),
          of("task", "milestone_id", `EXISTS (SELECT 1 FROM milestone m WHERE m.id = x.milestone_id AND ${inNest("m.project_id")})`),
        ];
      }
      case "milestones": return [of("task", "milestone_id", `x.milestone_id = ?1`)];
      case "states": return [
        of("task", "state_id", `x.state_id = ?1`),
        of("milestone", "state_id", `x.state_id = ?1`),
      ];
      case "stages": return [
        of("venture", "stage_id", `x.stage_id = ?1`),
        of("project", "stage_id", `x.stage_id = ?1`),
      ];
      case "tasks": return [of("blocker", "waits_on_task_id", `x.waits_on_task_id = ?1`)];
      default: return [];
    }
  }

  async deletePreview(owner: string, kind: Kind, id: string): Promise<DeletePreview | null> {
    const head = await this.one(
      `SELECT ${LABEL[kind]} AS label, x.archived_at,
              ${kind === "ventures" ? `(SELECT group_concat(k.name, ', ') FROM venture k WHERE k.parent_id = x.id AND k.owner = ?2)` : "NULL"} AS owns
       FROM ${TABLE[kind]} x WHERE x.id = ?1 AND x.owner = ?2`,
      id, owner,
    );
    if (head === null) return null;
    const label = str(head.label);
    const owns = optStr(head.owns);
    const refusal = optStr(head.archived_at) === null
      ? "Archive it first. Only something already archived can be deleted."
      : owns === null
        ? null
        // Decision 21 nests an owned venture inside its owner. That is a drawing, not a
        // licence to destroy a venture the person did not name.
        : `It owns ${owns}. Delete or move those first.`;

    const cascade = this.cascade(kind);
    const slots: (Kind | Edge)[] = [...(Object.keys(TABLE) as Kind[]), ...EDGES];
    const counted = await this.db.batch<Row>(slots.map((k) => this.db.prepare(
      k === kind
        ? `SELECT count(*) AS n FROM ${tableOf(k)} x WHERE x.owner = ?2 AND (x.id = ?1${cascade[k] === undefined ? "" : ` OR (${cascade[k]})`})`
        : cascade[k] === undefined
          ? `SELECT 0 AS n WHERE ?1 IS NOT NULL AND ?2 IS NOT NULL`
          : `SELECT count(*) AS n FROM ${tableOf(k)} x WHERE x.owner = ?2 AND (${cascade[k]})`,
    ).bind(id, owner)));
    const at = (k: Kind | Edge): number => num(counted[slots.indexOf(k)]?.results[0]?.n ?? 0);

    return {
      kind,
      id,
      label,
      confirm: NAMED[kind] ? label : "delete",
      removes: {
        ventures: at("ventures"),
        states: at("states"),
        stages: at("stages"),
        projects: at("projects"),
        milestones: at("milestones"),
        tasks: at("tasks"),
        blockers: at("blockers"),
        notes: at("notes"),
        decisions: at("decisions"),
        risks: at("risks"),
        links: at("links"),
        tags: at("tags"),
        taskTags: at("taskTags"),
        projectTags: at("projectTags"),
      },
      refusal,
    };
  }

  async remove(owner: string, kind: Kind, id: string, confirm: string): Promise<Outcome<{ removes: Removal; ventureId: string | null }>> {
    const preview = await this.deletePreview(owner, kind, id);
    if (preview === null) return { ok: false, status: 404, error: `${kind} ${id} was not found` };
    if (preview.refusal !== null) return { ok: false, status: 409, error: preview.refusal };
    if (confirm.trim() !== preview.confirm) {
      return { ok: false, status: 400, error: `Type ${preview.confirm} exactly to delete it.` };
    }

    const where = await this.one(`SELECT ${VENTURE_OF[kind]("x")} AS venture_id FROM ${TABLE[kind]} x WHERE x.id = ?1`, id);
    const ventureId = optStr(where?.venture_id);
    const cascade = this.cascade(kind);
    // Children before parents, so no foreign key is ever left pointing at nothing, and the
    // detachments first, so a row that survives has let go before its target is destroyed.
    // The tag edges go first of all: every row in them names a task, a project and a tag,
    // so nothing they name can be destroyed while they are still there. A tag goes last,
    // after the ventures, for the same reason read the other way round.
    const order: (Kind | Edge)[] = [
      "taskTags", "projectTags", "notes", "decisions", "risks", "links", "blockers", "tasks", "milestones",
      "projects", "states", "stages", "ventures", "tags",
    ];
    const statements: D1PreparedStatement[] = [];
    for (const d of this.detachments(kind)) {
      statements.push(this.db.prepare(
        `UPDATE ${d.table} AS x SET ${d.column} = NULL, updated_at = ?3 WHERE x.owner = ?2 AND (${d.where})`,
      ).bind(id, owner, this.now()));
    }
    for (const k of order) {
      const condition = k === kind ? `x.id = ?1${cascade[k] === undefined ? "" : ` OR (${cascade[k]})`}` : cascade[k];
      if (condition === undefined) continue;
      statements.push(this.db.prepare(`DELETE FROM ${tableOf(k)} AS x WHERE x.owner = ?2 AND (${condition})`).bind(id, owner));
    }
    if (kind === "ventures") {
      // Rows of the tables the trim cut still name a venture until the held drop runs, and no key cascades.
      const cut = (await this.ownedTables()).filter((t) => CUT_TABLES.includes(t.name));
      const dropped = cut.flatMap((t) => {
        const columns = t.refs.filter((r) => r.table === "venture").map((r) => r.column);
        if (columns.length === 0) return [];
        return [this.db.prepare(
          `DELETE FROM "${t.name}" WHERE owner = ?2 AND (${columns.map((c) => `"${c}" = ?1`).join(" OR ")})`,
        ).bind(id, owner)];
      });
      statements.unshift(...dropped);
    }
    try {
      await this.db.batch(statements);
    } catch (e) {
      return constraintOutcome(e);
    }
    return { ok: true, value: { removes: preview.removes, ventureId } };
  }

  private async createUnguarded<K extends Kind>(owner: string, kind: K, input: CreateInput[K], id: string): Promise<Outcome<Written<Records[K]>>> {
    const at = this.now();
    const stamp: Col[] = [col("id", id), col("owner", owner), col("created_at", at), col("updated_at", at)];
    const position = (value: number | undefined, scope: string, scopeValue: unknown): Col =>
      ["position", `COALESCE(?, (SELECT COALESCE(MAX(position), 0) + 1 FROM ${TABLE[kind]} WHERE ${scope} = ?))`,
        [value ?? null, scopeValue ?? null]];

    const k = kind as Kind;
    if (k === "ventures") {
      const i = input as CreateInput["ventures"];
      const parent = i.parentId ?? null;
      const rules = parent !== null ? parentRules(owner, parent) : [];
      const kept = (await this.appearance(owner)).defaultStages;
      // A sealed list cannot be read here, so a new space starts with the shipped stages and the device renames them.
      const stageList = Array.isArray(kept) ? kept : DEFAULT_NEW_STAGES;
      const states = DEFAULT_STATES.map((s, n) => this.db.prepare(
        `INSERT INTO state (id, owner, venture_id, name, kind, position, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM venture WHERE id = ?)`,
      ).bind(crypto.randomUUID(), owner, id, s.name, s.kind, n + 1, at, at, id));
      const stages = stageList.map((s, n) => this.db.prepare(
        `INSERT INTO stage (id, owner, venture_id, name, kind, position, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM venture WHERE id = ?)`,
      ).bind(crypto.randomUUID(), owner, id, s.name, s.kind, n + 1, at, at, id));
      return this.write(kind, id, this.insertStatement(kind, [
        ...stamp, col("name", i.name), col("icon", i.icon), col("description", i.description), col("parent_id", parent),
        position(i.position, "owner", owner),
      ], rules), rules, [...states, ...stages]);
    }
    if (k === "states") {
      const i = input as CreateInput["states"];
      const rules = [ventureRule(owner, i.ventureId)];
      return this.write(kind, id, this.insertStatement(kind, [
        ...stamp, col("venture_id", i.ventureId), col("name", i.name), col("kind", i.kind),
        position(i.position, "venture_id", i.ventureId),
      ], rules), rules);
    }
    if (k === "stages") {
      const i = input as CreateInput["stages"];
      const rules = [ventureRule(owner, i.ventureId)];
      return this.write(kind, id, this.insertStatement(kind, [
        ...stamp, col("venture_id", i.ventureId), col("name", i.name), col("kind", i.kind),
        position(i.position, "venture_id", i.ventureId),
      ], rules), rules);
    }
    if (k === "projects") {
      const i = input as CreateInput["projects"];
      const rules = [ventureRule(owner, i.ventureId)];
      const parent = i.parentId ?? null;
      if (parent !== null) rules.push(...projectParentRules(owner, parent, i.ventureId));
      const tagIds = this.tagIdsIn(i);
      if (tagIds !== null) rules.push(...tagIds.map((tagId) => tagRule(owner, tagId)));
      const cols = [
        ...stamp, col("venture_id", i.ventureId), col("parent_id", parent), col("name", i.name), col("icon", i.icon),
        col("description", i.description), col("who_for", i.whoFor), col("done_looks", i.doneLooks),
        col("open_questions", i.openQuestions), position(i.position, "venture_id", i.ventureId),
      ];
      return this.write(kind, id, this.insertStatement(kind, cols, rules), rules,
        tagIds === null ? [] : this.tagStatements("projectTags", owner, id, tagIds, rules, at));
    }
    if (k === "milestones") {
      const i = input as CreateInput["milestones"];
      const rules = [projectRule(owner, i.projectId)];
      if (i.stateId) rules.push(stateForProject(owner, i.stateId, i.projectId));
      return this.write(kind, id, this.insertStatement(kind, [
        ...stamp, col("project_id", i.projectId), col("state_id", i.stateId), col("name", i.name),
        col("aiming_on", i.aimingOn), position(i.position, "project_id", i.projectId),
      ], rules), rules);
    }
    if (k === "tasks") {
      const i = input as CreateInput["tasks"];
      const milestoneId = i.milestoneId ?? null;
      let projectId = i.projectId ?? null;
      if (milestoneId !== null && projectId === null) {
        const m = await this.one(`SELECT project_id FROM milestone WHERE id = ? AND owner = ?`, milestoneId, owner);
        if (m === null) return { ok: false, status: 404, error: `milestone ${milestoneId} was not found` };
        projectId = str(m.project_id);
      }
      const rules = [ventureRule(owner, i.ventureId)];
      if (projectId !== null) rules.push(projectInVenture(owner, projectId, i.ventureId));
      if (milestoneId !== null && projectId !== null) rules.push(milestoneInProject(owner, milestoneId, projectId));
      if (i.stateId) rules.push(stateInVenture(owner, i.stateId, i.ventureId));
      const tagIds = this.tagIdsIn(i);
      if (tagIds !== null) rules.push(...tagIds.map((tagId) => tagRule(owner, tagId)));
      const cols = [
        ...stamp, col("venture_id", i.ventureId), col("project_id", projectId), col("milestone_id", milestoneId),
        col("state_id", i.stateId), col("title", i.title), col("body", i.body),
        col("checklist", JSON.stringify(i.checklist ?? [])), col("priority", i.priority), col("due_on", i.dueOn),
        col("picked_on", i.pickedOn), position(i.position, "venture_id", i.ventureId),
        col("today_position", i.todayPosition ?? null),
        col("remind_at", i.remindAt ?? null), col("repeat", i.repeat ?? null),
      ];
      return this.write(kind, id, this.insertStatement(kind, cols, rules), rules,
        tagIds === null ? [] : this.tagStatements("taskTags", owner, id, tagIds, rules, at));
    }
    if (k === "blockers") {
      const i = input as CreateInput["blockers"];
      const rules = [
        taskRule(owner, i.taskId),
        rule(`NOT EXISTS (SELECT 1 FROM blocker r WHERE r.task_id = ? AND r.archived_at IS NULL)`, [i.taskId], 409,
          "that task already carries a blocker: change that one instead"),
      ];
      if (i.waitsOnTaskId) {
        rules.push(rule(`EXISTS (SELECT 1 FROM task r WHERE r.id = ? AND r.owner = ?)`, [i.waitsOnTaskId, owner], 404,
          `task ${i.waitsOnTaskId} was not found`));
      }
      return this.write(kind, id, this.insertStatement(kind, [
        ...stamp, col("task_id", i.taskId), col("reason", i.reason), col("waits_on_task_id", i.waitsOnTaskId),
        col("person", i.person), col("since_on", i.sinceOn),
      ], rules), rules);
    }
    if (k === "notes") {
      const i = input as CreateInput["notes"];
      const rules = i.ventureId ? [ventureRule(owner, i.ventureId)]
        : i.projectId ? [projectRule(owner, i.projectId)]
        : [rule("0", [], 400, "a note attaches to a venture or a project")];
      return this.write(kind, id, this.insertStatement(kind, [
        ...stamp, col("venture_id", i.ventureId), col("project_id", i.projectId), col("body", i.body),
      ], rules), rules);
    }
    if (k === "decisions" || k === "risks") {
      const i = input as CreateInput["decisions"] & CreateInput["risks"];
      const onVenture = Boolean(i.ventureId);
      const rules = i.ventureId ? [ventureRule(owner, i.ventureId)]
        : i.projectId ? [projectRule(owner, i.projectId)]
        : [rule("0", [], 400, `a ${k === "decisions" ? "decision" : "risk"} attaches to a venture or a project`)];
      return this.write(kind, id, this.insertStatement(kind, [
        ...stamp, col("venture_id", i.ventureId), col("project_id", i.projectId), col("title", i.title),
        col("body", i.body), col(k === "decisions" ? "decided_on" : "raised_on", k === "decisions" ? i.decidedOn : i.raisedOn),
        onVenture ? position(i.position, "venture_id", i.ventureId) : position(i.position, "project_id", i.projectId),
      ], rules), rules);
    }
    if (k === "tags") {
      // A name and nothing else. Two live tags cannot share one, and the unique index is
      // what says so: it answers through `constraintOutcome` as a 409.
      const i = input as CreateInput["tags"];
      const rules = [tagName(i.name)];
      return this.write(kind, id, this.insertStatement(kind, [...stamp, col("name", i.name)], rules), rules);
    }
    if (k === "links") {
      const i = input as CreateInput["links"];
      const rules = i.ventureId ? [ventureRule(owner, i.ventureId)]
        : i.projectId ? [projectRule(owner, i.projectId)]
        : i.taskId ? [taskRule(owner, i.taskId)]
        : [rule("0", [], 400, "a link attaches to a venture, a project or a task")];
      return this.write(kind, id, this.insertStatement(kind, [
        ...stamp, col("venture_id", i.ventureId), col("project_id", i.projectId), col("task_id", i.taskId),
        col("url", i.url), col("label", i.label), col("role", i.role ?? "other"),
      ], rules), rules);
    }
    // Every kind has a branch above. A new kind that forgets one fails to compile here
    // instead of being written as something else.
    const unhandled: never = k;
    throw new Error(`no create for ${String(unhandled)}`);
  }

  private async updateUnguarded<K extends Kind>(owner: string, kind: K, id: string, patch: PatchInput[K], today?: string): Promise<Outcome<Written<Records[K]>>> {
    const current = await this.one(`SELECT * FROM ${TABLE[kind]} WHERE id = ? AND owner = ?`, id, owner);
    if (current === null) return { ok: false, status: 404, error: `${kind} ${id} was not found` };
    const at = this.now();
    const rules: Rule[] = [];
    const extra: D1PreparedStatement[] = [];
    let sets: Col[];
    let next: NextTask | null = null;
    const p = patch as Record<string, unknown>;

    const k = kind as Kind;
    if (k === "ventures") {
      sets = patched(patch, [["name", "name"], ["icon", "icon"], ["description", "description"], ["position", "position"],
        ["parentId", "parent_id"],
        ["stageId", "stage_id"], ["monogram", "monogram"]]);
      if ("atRisk" in p) sets.push(col("at_risk", p.atRisk ? 1 : 0));
      if ("views" in p) sets.push(col("views", JSON.stringify(p.views)));
      const stageId = optStr(p.stageId);
      if ("stageId" in p && stageId !== null) rules.push(stageInVenture(owner, stageId, id));
      const parent = "parentId" in p ? optStr(p.parentId) : optStr(current.parent_id);
      if ("parentId" in p && parent !== optStr(current.parent_id) && parent !== null) {
        rules.push(
          rule("? <> ?", [parent, id], 409, "a venture cannot be its own parent"),
          ...parentRules(owner, parent),
          rule(`NOT EXISTS (SELECT 1 FROM venture r WHERE r.parent_id = ?)`, [id], 409,
            `ventures nest two levels deep, and ${id} has ventures of its own`),
        );
      }
    } else if (k === "states") {
      sets = patched(patch, [["name", "name"], ["kind", "kind"], ["position", "position"]]);
    } else if (k === "stages") {
      sets = patched(patch, [["name", "name"], ["kind", "kind"], ["position", "position"]]);
    } else if (k === "projects") {
      sets = patched(patch, [["name", "name"], ["icon", "icon"], ["description", "description"], ["position", "position"], ["ventureId", "venture_id"],
        ["stageId", "stage_id"], ["parentId", "parent_id"], ["pinnedAt", "pinned_at"],
        ["whoFor", "who_for"], ["doneLooks", "done_looks"], ["openQuestions", "open_questions"]]);
      if ("atRisk" in p) sets.push(col("at_risk", p.atRisk ? 1 : 0));
      const target = optStr(p.ventureId);
      const stageId = optStr(p.stageId);
      const ventureOfProject = "ventureId" in p && target !== null ? target : str(current.venture_id);
      const ventureMoves = ventureOfProject !== str(current.venture_id);
      // A project that moves to another venture on its own leaves the project it was inside,
      // unless the patch names one in the venture it is going to.
      if (ventureMoves && !("parentId" in p)) sets.push(col("parent_id", null));
      const parent = "parentId" in p ? optStr(p.parentId) : null;
      if (parent !== null && (parent !== optStr(current.parent_id) || ventureMoves)) {
        rules.push(
          rule("? <> ?", [parent, id], 409, "a project cannot be inside itself"),
          ...projectParentRules(owner, parent, ventureOfProject),
          rule(`NOT EXISTS (SELECT 1 FROM project r WHERE r.parent_id = ?)`, [id], 409,
            `projects nest one level deep, and ${id} holds projects of its own`),
        );
      }
      if ("stageId" in p && stageId !== null) {
        rules.push(stageInVenture(owner, stageId, ventureOfProject));
      } else if (!("stageId" in p) && ventureOfProject !== str(current.venture_id) && current.stage_id !== null) {
        // A moved project takes the target's first stage of the kind it was at, or none.
        sets.push(["stage_id", MAPPED_STAGE, [ventureOfProject, current.stage_id]]);
      }
      if ("ventureId" in p && target !== null && target !== str(current.venture_id)) {
        // The project takes its tasks and milestones with it, each into the target
        // venture's first state of the kind it was in.
        rules.push(ventureRule(owner, target));
        const moved = `EXISTS (SELECT 1 FROM project mp WHERE mp.id = ?3 AND mp.venture_id = ?1)`;
        const nest = `SELECT n.id FROM project n WHERE n.id = ?3 OR n.parent_id = ?3`;
        const mapped = (table: string) =>
          `(SELECT s2.id FROM state s2 WHERE s2.venture_id = ?1 AND s2.archived_at IS NULL` +
          ` AND s2.kind = (SELECT s1.kind FROM state s1 WHERE s1.id = ${table}.state_id) ORDER BY s2.position, s2.created_at LIMIT 1)`;
        extra.push(
          this.db.prepare(
            `UPDATE task SET venture_id = ?1, updated_at = ?2,
               state_id = CASE WHEN task.state_id IS NULL THEN NULL ELSE ${mapped("task")} END
             WHERE task.project_id IN (${nest}) AND ${moved}`,
          ).bind(target, at, id),
          this.db.prepare(
            `UPDATE milestone SET updated_at = ?2,
               state_id = CASE WHEN milestone.state_id IS NULL THEN NULL ELSE ${mapped("milestone")} END
             WHERE milestone.project_id IN (${nest}) AND ${moved}`,
          ).bind(target, at, id),
          // The projects inside it go too, archived ones included, so a child is always in its
          // parent's venture. Each takes the target's stage of the kind it was at, as it does.
          this.db.prepare(
            `UPDATE project SET venture_id = ?1, updated_at = ?2,
               stage_id = CASE WHEN project.stage_id IS NULL THEN NULL ELSE
                 (SELECT g2.id FROM stage g2 WHERE g2.venture_id = ?1 AND g2.archived_at IS NULL
                    AND g2.kind = (SELECT g1.kind FROM stage g1 WHERE g1.id = project.stage_id)
                  ORDER BY g2.position, g2.created_at LIMIT 1) END
             WHERE project.parent_id = ?3 AND ${moved}`,
          ).bind(target, at, id),
        );
      }
    } else if (k === "milestones") {
      sets = patched(patch, [["name", "name"], ["stateId", "state_id"], ["aimingOn", "aiming_on"], ["position", "position"]]);
      const stateId = optStr(p.stateId);
      if ("stateId" in p && stateId !== null) rules.push(stateForProject(owner, stateId, str(current.project_id)));
    } else if (k === "tasks") {
      sets = patched(patch, [
        ["title", "title"], ["body", "body"], ["priority", "priority"], ["dueOn", "due_on"],
        ["pickedOn", "picked_on"], ["position", "position"],
        ["todayPosition", "today_position"], ["remindAt", "remind_at"], ["repeat", "repeat"],
      ]);
      if ("checklist" in p) sets.push(col("checklist", JSON.stringify(p.checklist ?? [])));

      const ventureId = "ventureId" in p && p.ventureId ? str(p.ventureId) : str(current.venture_id);
      const ventureChanged = ventureId !== str(current.venture_id);
      let projectId = "projectId" in p ? optStr(p.projectId) : ventureChanged ? null : optStr(current.project_id);
      const projectChanged = projectId !== optStr(current.project_id);
      const milestoneId = "milestoneId" in p ? optStr(p.milestoneId)
        : ventureChanged || projectChanged ? null : optStr(current.milestone_id);
      if (milestoneId !== null && projectId === null) {
        const m = await this.one(`SELECT project_id FROM milestone WHERE id = ? AND owner = ?`, milestoneId, owner);
        if (m === null) return { ok: false, status: 404, error: `milestone ${milestoneId} was not found` };
        projectId = str(m.project_id);
      }

      if (ventureChanged) rules.push(ventureRule(owner, ventureId));
      if (projectId !== null && projectId !== optStr(current.project_id)) rules.push(projectInVenture(owner, projectId, ventureId));
      else if (projectId !== null && ventureChanged) rules.push(projectInVenture(owner, projectId, ventureId));
      if (milestoneId !== null && milestoneId !== optStr(current.milestone_id)) rules.push(milestoneInProject(owner, milestoneId, projectId ?? ""));
      sets.push(col("venture_id", ventureId), col("project_id", projectId), col("milestone_id", milestoneId));

      const stateId = optStr(p.stateId);
      if ("stateId" in p) {
        sets.push(col("state_id", stateId));
        if (stateId !== null) rules.push(stateInVenture(owner, stateId, ventureId));
      } else if (ventureChanged && current.state_id !== null) {
        sets.push(["state_id", MAPPED_STATE, [ventureId, current.state_id]]);
      }

      if ("stateId" in p && stateId !== null && current.archived_at === null) {
        next = await this.nextTask(owner, current, p, { ventureId, projectId, milestoneId, stateId }, today ?? this.now().slice(0, 10));
      }
    } else if (k === "blockers") {
      sets = patched(patch, [["reason", "reason"], ["waitsOnTaskId", "waits_on_task_id"], ["person", "person"], ["sinceOn", "since_on"]]);
      const waitsOn = optStr(p.waitsOnTaskId);
      if (waitsOn !== null) {
        rules.push(rule(`EXISTS (SELECT 1 FROM task r WHERE r.id = ? AND r.owner = ?)`, [waitsOn, owner], 404, `task ${waitsOn} was not found`));
      }
    } else if (k === "notes") {
      sets = patched(patch, [["body", "body"]]);
    } else if (k === "decisions") {
      sets = patched(patch, [["title", "title"], ["body", "body"], ["decidedOn", "decided_on"], ["position", "position"]]);
    } else if (k === "risks") {
      sets = patched(patch, [["title", "title"], ["body", "body"], ["raisedOn", "raised_on"], ["position", "position"]]);
    } else if (k === "tags") {
      sets = patched(patch, [["name", "name"]]);
      if ("name" in p) rules.push(tagName(str(p.name)));
    } else if (k === "links") {
      sets = patched(patch, [["url", "url"], ["label", "label"], ["role", "role"]]);
    } else {
      const unhandled: never = k;
      throw new Error(`no update for ${String(unhandled)}`);
    }

    // Last, so the tag statements carry every rule this patch collected: a patch that is
    // refused for any other reason leaves the tags it had alone.
    if (k === "tasks" || k === "projects") {
      const tagIds = this.tagIdsIn(patch as { readonly tagIds?: readonly string[] });
      if (tagIds !== null) {
        rules.push(...tagIds.map((tagId) => tagRule(owner, tagId)));
        extra.push(...this.tagStatements(k === "tasks" ? "taskTags" : "projectTags", owner, id, tagIds, rules, at));
      }
    }

    if (next !== null) {
      const made = this.spawnStatements(owner, id, next, rules, at);
      return this.write(kind, id, this.updateStatement(kind, owner, id, sets, rules, at), rules, [...extra, ...made.after], made.insert);
    }
    return this.write(kind, id, this.updateStatement(kind, owner, id, sets, rules, at), rules, extra);
  }

  /**
   * What finishing this task makes, or null when it makes nothing: the task has no repeat that
   * parses, it was finished already, or the state it is moving to is not a finished one. Reads
   * only, and a repeat that does not parse is no reason to refuse the patch. The statements
   * that write it are `spawnStatements`, and they check again at write time that the task is
   * still unfinished, so two finishes racing make one task.
   */
  private async nextTask(
    owner: string, current: Row, p: Record<string, unknown>,
    where: { ventureId: string; projectId: string | null; milestoneId: string | null; stateId: string }, today: string,
  ): Promise<NextTask | null> {
    const text = "repeat" in p ? optStr(p.repeat) : optStr(current.repeat);
    const repeat = parseRepeat(text);
    if (repeat === null) return null;
    const row = await this.one(
      `SELECT (SELECT kind FROM state WHERE id = ?1 AND owner = ?2) AS to_kind,
              (SELECT kind FROM state WHERE id = ?3 AND owner = ?2) AS from_kind,
              (SELECT id FROM state WHERE venture_id = ?4 AND owner = ?2 AND kind = 'not_started' AND archived_at IS NULL
                ORDER BY position, created_at LIMIT 1) AS first_id`,
      where.stateId, owner, optStr(current.state_id), where.ventureId);
    if (row === null || optStr(row.to_kind) !== "finished" || optStr(row.from_kind) === "finished") return null;
    // On an encrypted account `title` is an envelope bound to the finished task's id. The Worker
    // cannot reseal it, so the copy is opened under the finished id by the device, which writes
    // the title back to the new task (src/web/api.ts, resealSpawned).
    const was = "dueOn" in p ? optStr(p.dueOn) : optStr(current.due_on);
    const due = nextDue(repeat, was ?? today, today);
    const remind = "remindAt" in p ? optStr(p.remindAt) : optStr(current.remind_at);
    return {
      sourceId: str(current.id),
      ventureId: where.ventureId,
      projectId: where.projectId,
      milestoneId: where.milestoneId,
      stateId: optStr(row.first_id),
      title: "title" in p ? str(p.title) : str(current.title),
      priority: "priority" in p ? optStr(p.priority) : optStr(current.priority),
      dueOn: due,
      remindAt: remind === null ? null : `${due}${remind.slice(10)}`,
      repeat: text,
    };
  }

  /** The insert of the next task, to run before the update, and its tags, to run after. */
  private spawnStatements(
    owner: string, sourceId: string, next: NextTask, rules: readonly Rule[], at: string,
  ): { insert: D1PreparedStatement; after: D1PreparedStatement[] } {
    const id = crypto.randomUUID();
    const unfinished = rule(
      `EXISTS (SELECT 1 FROM task c WHERE c.id = ? AND c.owner = ? AND c.archived_at IS NULL` +
      ` AND COALESCE((SELECT s.kind FROM state s WHERE s.id = c.state_id), '') <> 'finished')`,
      [sourceId, owner], 409, "that task was finished already");
    const guard = [...rules, unfinished];
    const insert = this.insertStatement("tasks", [
      col("id", id), col("owner", owner), col("created_at", at), col("updated_at", at),
      col("venture_id", next.ventureId), col("project_id", next.projectId), col("milestone_id", next.milestoneId),
      col("state_id", next.stateId), col("title", next.title), col("body", null), col("checklist", "[]"),
      col("priority", next.priority), col("due_on", next.dueOn), col("picked_on", null),
      ["position", `COALESCE((SELECT MAX(position) FROM task WHERE venture_id = ?), 0) + 1`, [next.ventureId]],
      col("today_position", null), col("remind_at", next.remindAt), col("repeat", next.repeat),
    ], guard);
    const tags = this.db.prepare(
      `INSERT INTO task_tag (id, owner, task_id, tag_id, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), e.owner, ?, e.tag_id, ?, ? FROM task_tag e
       WHERE e.task_id = ? AND e.owner = ? AND e.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM tag g WHERE g.id = e.tag_id AND g.archived_at IS NOT NULL)
         AND EXISTS (SELECT 1 FROM task n WHERE n.id = ? AND n.owner = ?)`,
    ).bind(id, at, at, sourceId, owner, id, owner);
    return { insert, after: [tags] };
  }

  private insertStatement(kind: Kind, cols: readonly Col[], rules: readonly Rule[]): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO ${TABLE[kind]} (${cols.map((c) => c[0]).join(", ")})
       SELECT ${cols.map((c) => c[1]).join(", ")} WHERE ${whereOf(rules)} RETURNING *`,
    ).bind(...cols.flatMap((c) => c[2]), ...rules.flatMap((r) => r.binds));
  }

  private updateStatement(kind: Kind, owner: string, id: string, sets: readonly Col[], rules: readonly Rule[], at: string): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE ${TABLE[kind]} SET ${[...sets.map((c) => `${c[0]} = ${c[1]}`), "updated_at = ?"].join(", ")}
       WHERE id = ? AND owner = ? AND ${whereOf(rules)} RETURNING *`,
    ).bind(...sets.flatMap((c) => c[2]), at, id, owner, ...rules.flatMap((r) => r.binds));
  }

  /**
   * The tags on a task or a project, written whole: what it carried goes, and one row per id
   * given takes its place. Repeats are the same assignment said twice, so they are folded
   * into one before the insert rather than refused.
   *
   * Every statement carries the write's own rules, so it lands only where the write did. A
   * refused write leaves the tags exactly as they were, and the rules ride into the same
   * batch, so saying which tags a task has costs no extra round trip.
   *
   * "Whole" means the tags the caller was shown, and an archived tag is not one of them:
   * `TAG_IDS` leaves it out of what is read, so a caller sending back the list it read has
   * said nothing about it either way. See the predicate on the DELETE.
   */
  private tagStatements(
    edge: Edge, owner: string, id: string, tagIds: readonly string[], rules: readonly Rule[], at: string,
  ): D1PreparedStatement[] {
    const table = EDGE_TABLE[edge];
    const column = EDGE_COLUMN[edge];
    const guard = whereOf(rules);
    const binds = rules.flatMap((r) => r.binds);
    return [
      // The assignments of an archived tag are spared. `TAG_IDS` drops an archived tag from
      // what is read, which is right — an assignment is put away by putting away either end
      // of it — but it means a whole-value write is answering about a list it was never
      // given the whole of. Archive "legal" while a task still carries it, open that task's
      // picker and save any other change, and without this the join row would go and
      // unarchiving "legal" would bring nothing back. An assignment nobody was shown is not
      // theirs to destroy, and that is the only reading under which writing the whole value
      // is safe against reading a filtered one. Putting it here rather than in the client
      // keeps the correctness off the caller, and every caller there will ever be.
      this.db.prepare(
        `DELETE FROM ${table} WHERE ${column} = ? AND owner = ?
         AND NOT EXISTS (SELECT 1 FROM tag g WHERE g.id = tag_id AND g.archived_at IS NOT NULL) AND ${guard}`,
      ).bind(id, owner, ...binds),
      ...tagIds.map((tagId) => this.db.prepare(
        `INSERT INTO ${table} (id, owner, ${column}, tag_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`,
      ).bind(crypto.randomUUID(), owner, id, tagId, at, at, ...binds)),
    ];
  }

  /** The tags a write says to put on something, each named once, in the order given. */
  private tagIdsIn(input: { readonly tagIds?: readonly string[] }): string[] | null {
    return input.tagIds === undefined ? null : [...new Set(input.tagIds)];
  }

  /**
   * One round trip: the write, anything that moves with it, and the venture it landed in.
   * When the write changed nothing, ask its rules one at a time which refused.
   */
  private async write<K extends Kind>(
    kind: K, id: string, primary: D1PreparedStatement, rules: readonly Rule[], extra: readonly D1PreparedStatement[] = [],
    spawn?: D1PreparedStatement,
  ): Promise<Outcome<Written<Records[K]>>> {
    const where = this.db.prepare(`SELECT ${VENTURE_OF[kind]("x")} AS venture_id FROM ${TABLE[kind]} x WHERE x.id = ?`).bind(id);
    // The next task goes in ahead of the update, so its guard sees the task as it was.
    const results = await this.db.batch<Row>(spawn === undefined ? [primary, ...extra, where] : [spawn, primary, ...extra, where]);
    const row = results[spawn === undefined ? 0 : 1]?.results[0];
    if (row === undefined) return this.explain(rules);
    const ventureRow = results[results.length - 1]?.results[0];
    const spawned = spawn === undefined ? undefined : results[0]?.results[0];
    return {
      ok: true,
      value: {
        record: (MAP[kind] as (r: Row) => Records[K])(row),
        ventureId: optStr(ventureRow?.venture_id),
        ...(spawned === undefined ? {} : { spawned: MAP.tasks(spawned) }),
      },
    };
  }

  private async explain(rules: readonly Rule[]): Promise<Outcome<never>> {
    if (rules.length > 0) {
      const results = await this.db.batch<Row>(
        rules.map((r) => this.db.prepare(`SELECT CASE WHEN ${r.sql} THEN 1 ELSE 0 END AS ok`).bind(...r.binds)),
      );
      for (const [n, result] of results.entries()) {
        const refused = rules[n];
        if (refused !== undefined && num(result.results[0]?.ok) !== 1) {
          return { ok: false, status: refused.status, error: refused.error };
        }
      }
    }
    return { ok: false, status: 409, error: "that changed while it was being written: try again" };
  }

  // -- accounts ------------------------------------------------------------

  async attempt(email: string | null, limits: readonly AttemptLimit[], at: string, since: string, sweepBefore: string) {
    const statements = [this.db.prepare(`DELETE FROM throttle WHERE at < ?`).bind(sweepBefore)];
    if (limits.length > 0) {
      // SQLite reads the whole SELECT before it inserts a row of it, because it reads the
      // table it inserts into, so every count here is the count before this attempt.
      const under = limits.map(() => `(SELECT COUNT(*) FROM throttle c WHERE c.key = ? AND c.at >= ?) < ?`).join(" AND ");
      statements.push(this.db.prepare(
        `INSERT INTO throttle (key, at) SELECT k.column1, ? FROM (VALUES ${limits.map(() => "(?)").join(", ")}) k
         WHERE ${under} RETURNING rowid`,
      ).bind(at, ...limits.map((l) => l.key), ...limits.flatMap((l) => [l.key, since, l.limit])));
    }
    if (email !== null) statements.push(this.db.prepare(`SELECT * FROM account WHERE email = ?`).bind(normalEmail(email)));
    const results = await this.db.batch<Row>(statements);
    const recorded = limits.length > 0 ? (results[1]?.results ?? []).map((r) => num(r.rowid)) : [];
    const row = email === null ? undefined : results.at(-1)?.results[0];
    return {
      account: row === undefined ? null : accountFrom(row),
      reserved: recorded.length === limits.length ? recorded : null,
    };
  }

  async forgetAttempts(keys: readonly string[], reserved: readonly number[] = []): Promise<void> {
    const which = [
      ...(keys.length === 0 ? [] : [`key IN (${marks(keys.length)})`]),
      ...(reserved.length === 0 ? [] : [`rowid IN (${marks(reserved.length)})`]),
    ];
    if (which.length === 0) return;
    await this.db.prepare(`DELETE FROM throttle WHERE ${which.join(" OR ")}`).bind(...keys, ...reserved).run();
  }

  async account(owner: string): Promise<AccountSecret | null> {
    const row = await this.one(`SELECT * FROM account WHERE id = ?`, owner);
    return row === null ? null : accountFrom(row);
  }

  async appearance(owner: string): Promise<AccountSettings> {
    const row = await this.one(`SELECT ${SETTINGS_COLUMNS} FROM account WHERE id = ?`, owner);
    return row === null ? NO_SETTINGS : appearanceFrom(row);
  }

  async firstRun(owner: string): Promise<FirstRun> {
    const row = await this.one(`SELECT first_run_step, tips_seen FROM account WHERE id = ?`, owner);
    return row === null ? { step: null, tipsSeen: null } : firstRunFrom(row);
  }

  async setFirstRun(owner: string, change: FirstRunChange): Promise<Outcome<FirstRun>> {
    const row = await this.one(`SELECT first_run_step, tips_seen FROM account WHERE id = ?`, owner);
    if (row === null) return { ok: false, status: 404, error: "this account has no first steps" };
    const now = firstRunFrom(row);
    if ("step" in change) {
      await this.db.prepare(`UPDATE account SET first_run_step = ?, updated_at = ? WHERE id = ?`).bind(change.step, this.now(), owner).run();
      return { ok: true, value: { ...now, step: change.step } };
    }
    // A tip is added once, the newest kept; an account with no list is not shown tips, so nothing is added.
    if (now.tipsSeen === null || now.tipsSeen.includes(change.tipSeen)) return { ok: true, value: now };
    const tipsSeen = [...now.tipsSeen, change.tipSeen].slice(-TIPS_KEPT);
    await this.db.prepare(`UPDATE account SET tips_seen = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(tipsSeen), this.now(), owner).run();
    return { ok: true, value: { ...now, tipsSeen } };
  }

  async keys(owner: string): Promise<KeySet> {
    const rows = await this.db.prepare(
      `SELECT * FROM key_wrap WHERE owner = ? AND archived_at IS NULL ORDER BY created_at, id`,
    ).bind(owner).all<Row>();
    const first = rows.results[0];
    return {
      keyRef: first === undefined ? null : str(first.key_ref),
      keyCheck: first === undefined ? null : str(first.key_check),
      wraps: rows.results.map((r) => ({
        id: str(r.id), kind: str(r.kind) as KeyKind, label: str(r.label), deviceId: optStr(r.device_id),
        credentialId: optStr(r.credential_id), salt: optStr(r.salt),
        iterations: r.iterations === null ? null : num(r.iterations), wrapped: optStr(r.wrapped), createdAt: str(r.created_at),
      })),
    };
  }

  private insertWrap(owner: string, keyRef: string, keyCheck: string, w: KeyWrapInput, at: string, guarded: boolean): D1PreparedStatement {
    const cells = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`;
    const binds = [w.id, owner, keyRef, keyCheck, w.kind, w.label, w.deviceId, w.credentialId, w.salt, w.iterations, w.wrapped, at];
    const columns = `id, owner, key_ref, key_check, kind, label, device_id, credential_id, salt, iterations, wrapped, created_at`;
    if (!guarded) return this.db.prepare(`INSERT INTO key_wrap (${columns}) VALUES (${cells})`).bind(...binds);
    // Does nothing when this owner has live rows under another key, even if one slipped in since the check.
    return this.db.prepare(
      `INSERT INTO key_wrap (${columns}) SELECT ${cells}
       WHERE NOT EXISTS (SELECT 1 FROM key_wrap WHERE owner = ? AND archived_at IS NULL AND (key_ref <> ? OR key_check <> ?))`,
    ).bind(...binds, owner, keyRef, keyCheck);
  }

  /** A passkey row may name a device row only of this owner and this key: one in the same send, or a live one. */
  private async deviceRefsHold(owner: string, keyRef: string, wraps: KeyWrapInput[]): Promise<boolean> {
    if (wraps.every((w) => w.deviceId === null)) return true;
    const sent = new Set(wraps.filter((w) => w.kind === "device").map((w) => w.id));
    const live = await this.db.prepare(
      `SELECT id FROM key_wrap WHERE owner = ? AND key_ref = ? AND kind = 'device' AND archived_at IS NULL`,
    ).bind(owner, keyRef).all<Row>();
    const have = new Set([...sent, ...live.results.map((r) => str(r.id))]);
    return wraps.every((w) => w.deviceId === null || have.has(w.deviceId));
  }

  private async writeKeys(owner: string, bundle: KeyBundle, archiveAll: boolean): Promise<Outcome<KeySet>> {
    const at = this.now();
    if (!archiveAll) {
      const other = await this.one(
        `SELECT 1 AS found FROM key_wrap WHERE owner = ? AND archived_at IS NULL AND (key_ref <> ? OR key_check <> ?) LIMIT 1`,
        owner, bundle.keyRef, bundle.keyCheck,
      );
      if (other !== null) return { ok: false, status: 409, error: "This account already has a different key." };
    }
    // Device rows first, so a passkey row can name the device row sent beside it.
    const ordered = [...bundle.wraps.filter((w) => w.kind === "device"), ...bundle.wraps.filter((w) => w.kind !== "device")];
    // A start-again names only rows of its own send, since every live row is archived with it.
    const holds = archiveAll
      ? ordered.every((w) => w.deviceId === null || ordered.some((d) => d.kind === "device" && d.id === w.deviceId))
      : await this.deviceRefsHold(owner, bundle.keyRef, ordered);
    if (!holds) return { ok: false, status: 404, error: "no such device" };
    const statements: D1PreparedStatement[] = [];
    if (archiveAll) {
      statements.push(this.db.prepare(`UPDATE key_wrap SET archived_at = ? WHERE owner = ? AND archived_at IS NULL`).bind(at, owner));
    }
    for (const w of ordered) statements.push(this.insertWrap(owner, bundle.keyRef, bundle.keyCheck, w, at, !archiveAll));
    try {
      await this.db.batch(statements);
    } catch (e) {
      if (isUnique(e)) return { ok: false, status: 409, error: "One of those keys is already stored." };
      throw e;
    }
    return { ok: true, value: await this.keys(owner) };
  }

  addKeys(owner: string, bundle: KeyBundle): Promise<Outcome<KeySet>> {
    return this.writeKeys(owner, bundle, false);
  }

  startAgain(owner: string, bundle: KeyBundle): Promise<Outcome<KeySet>> {
    return this.writeKeys(owner, bundle, true);
  }

  async archiveKey(owner: string, id: string): Promise<Outcome<{ readonly archived: number }>> {
    const row = await this.one(`SELECT kind FROM key_wrap WHERE id = ? AND owner = ? AND archived_at IS NULL`, id, owner);
    if (row === null) return { ok: false, status: 404, error: "no such key" };
    const at = this.now();
    const [one, made] = await this.db.batch([
      this.db.prepare(`UPDATE key_wrap SET archived_at = ? WHERE id = ? AND owner = ? AND archived_at IS NULL`).bind(at, id, owner),
      this.db.prepare(
        `UPDATE key_wrap SET archived_at = ? WHERE device_id = ? AND owner = ? AND kind = 'passkey' AND archived_at IS NULL`,
      ).bind(at, id, owner),
    ]);
    return { ok: true, value: { archived: (one?.meta.changes ?? 0) + (made?.meta.changes ?? 0) } };
  }

  async replaceRecovery(owner: string, wrap: KeyWrapInput): Promise<Outcome<KeySet>> {
    const now = await this.keys(owner);
    if (now.keyRef === null || now.keyCheck === null) return { ok: false, status: 409, error: "This account has no key yet." };
    const at = this.now();
    try {
      await this.db.batch([
        this.db.prepare(`UPDATE key_wrap SET archived_at = ? WHERE owner = ? AND kind = 'recovery' AND archived_at IS NULL`).bind(at, owner),
        this.insertWrap(owner, now.keyRef, now.keyCheck, wrap, at, false),
      ]);
    } catch (e) {
      if (isUnique(e)) return { ok: false, status: 409, error: "One of those keys is already stored." };
      throw e;
    }
    return { ok: true, value: await this.keys(owner) };
  }

  async openPairing(owner: string, id: string): Promise<Outcome<{ readonly id: string; readonly expiresAt: string }>> {
    const at = new Date(this.now());
    const expiresAt = new Date(at.getTime() + PAIRING_MS).toISOString();
    try {
      await this.db.prepare(`INSERT INTO key_pairing (id, owner, expires_at, created_at) VALUES (?, ?, ?, ?)`)
        .bind(id, owner, expiresAt, at.toISOString()).run();
    } catch (e) {
      if (isUnique(e)) return { ok: false, status: 409, error: "That pairing is already open." };
      throw e;
    }
    return { ok: true, value: { id, expiresAt } };
  }

  async fillPairing(owner: string, id: string, parts: { readonly sealed: string }): Promise<Outcome<{ readonly filled: true }>> {
    const result = await this.db.prepare(
      `UPDATE key_pairing SET sealed = ?
       WHERE id = ? AND owner = ? AND archived_at IS NULL AND expires_at >= ? AND sealed IS NULL`,
    ).bind(parts.sealed, id, owner, this.now()).run();
    if ((result.meta.changes ?? 0) > 0) return { ok: true, value: { filled: true } };
    const open = await this.one(
      `SELECT sealed FROM key_pairing WHERE id = ? AND owner = ? AND archived_at IS NULL AND expires_at >= ?`, id, owner, this.now(),
    );
    if (open === null) return { ok: false, status: 404, error: "no such pairing" };
    return { ok: false, status: 409, error: "That pairing is already filled." };
  }

  async readPairing(owner: string, id: string): Promise<Outcome<PairingRead>> {
    // One statement reads the parts and archives the row, so two readers cannot both receive them.
    const taken = await this.db.prepare(
      `UPDATE key_pairing SET archived_at = ?
       WHERE id = ? AND owner = ? AND archived_at IS NULL AND expires_at >= ? AND sealed IS NOT NULL
       RETURNING sealed`,
    ).bind(this.now(), id, owner, this.now()).first<Row>();
    if (taken !== null) return { ok: true, value: { sealed: str(taken.sealed) } };
    const open = await this.one(
      `SELECT 1 AS found FROM key_pairing WHERE id = ? AND owner = ? AND archived_at IS NULL AND expires_at >= ?`, id, owner, this.now(),
    );
    return open === null ? { ok: false, status: 404, error: "no such pairing" } : { ok: true, value: { waiting: true } };
  }

  async setAppearance(owner: string, change: AccountSettingsChange): Promise<Outcome<AccountSettings>> {
    const row = await this.one(`SELECT ${SETTINGS_COLUMNS} FROM account WHERE id = ?`, owner);
    if (row === null) return { ok: false, status: 404, error: "this account has no settings to change" };
    // What is stored for each level: a name sent replaces it, null puts it back, the rest stay.
    const plan = planSettings(row, change);
    const plainName = Object.values(change.levelNames ?? {}).some((v) => typeof v === "string" && !isEnvelopeShape(v));
    if ((plainName || Array.isArray(change.defaultStages)) && encryptionOf(row.encryption) === "on") {
      return { ok: false, status: 409, error: SEALED_ONLY };
    }
    // A space is the caller's own or it does not exist: someone else's is not revealed.
    if (change.newTaskVentureId !== undefined && change.newTaskVentureId !== null) {
      const owned = await this.one(`SELECT id FROM venture WHERE id = ? AND owner = ?`, change.newTaskVentureId, owner);
      if (owned === null) return { ok: false, status: 404, error: "that space does not exist" };
    }
    await this.settingsUpdate(owner, plan).run();
    return { ok: true, value: plan.next };
  }

  /** The one statement that writes every settings column from a plan. */
  private settingsUpdate(owner: string, plan: SettingsPlan): D1PreparedStatement {
    const { next, levelColumns, extras } = plan;
    return this.db.prepare(
      `UPDATE account SET accent = ?, spacing = ?, theme = ?, map_style = ?, new_task_venture_id = ?, last_review_on = ?,
         remind_morning = ?, remind_tasks = ?, quiet_from = ?, quiet_to = ?,
         level_space = ?, level_project = ?, level_milestone = ?, level_task = ?,
         default_stages = ?, start_on = ?, extras = ?, time_zone = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      next.accent, next.spacing, next.theme, next.mapStyle, next.newTaskVentureId, next.lastReviewOn,
      next.morningAt, next.taskReminders ? 1 : 0, next.quietFrom, next.quietTo,
      ...levelColumns, typeof next.defaultStages === "string" ? next.defaultStages : next.defaultStages === null ? null : JSON.stringify(next.defaultStages), next.startOn,
      JSON.stringify(extras), next.timeZone, this.now(), owner,
    );
  }

  // -- full encryption -------------------------------------------------------

  private async stateOf(owner: string): Promise<EncryptionState> {
    return encryptionOf((await this.one(`SELECT encryption FROM account WHERE id = ?`, owner))?.encryption);
  }

  /** A 409 when the account is fully encrypted and `fields` hold plain typed text, else null. */
  private async plainRefused(owner: string, kind: string, fields: object): Promise<Outcome<never> | null> {
    if (plainTyped(kind, fields) === null) return null;
    return (await this.stateOf(owner)) === "on" ? { ok: false, status: 409, error: SEALED_ONLY } : null;
  }

  async encryption(owner: string): Promise<EncryptionReport> {
    const tables = (Object.keys(SEAL_TABLES) as SealKind[]).map((kind) => {
      const { table, owned, columns } = SEAL_TABLES[kind];
      const cells = Object.values(columns).filter((c) => !(table === "task" && c === "checklist"));
      // A cell is counted when it holds something. A locked envelope is the lock's, so it is not unsealed.
      const unsealed = cells.map((c) => `TOTAL(CASE WHEN ${c} IS NOT NULL AND ${c} <> '' AND NOT ${sealedSql(c)} THEN 1 ELSE 0 END)`);
      // A column a person can lock holds the lock's envelope or this account's own, under the same key and binding, and
      // nothing tells them apart. Under this account's current key one counts as sealed, so turning off opens it and cannot
      // finish while one is left; an envelope under any other key is not this run's to open.
      const current = "(SELECT key_ref FROM key_wrap WHERE owner = ?1 AND archived_at IS NULL LIMIT 1)";
      const sealed = cells.map((c) => isLockColumn(table, c)
        ? `TOTAL(CASE WHEN ${sealedSql(c)} AND substr(${c}, 4, 11) = ${current} THEN 1 ELSE 0 END)`
        : `TOTAL(CASE WHEN ${sealedSql(c)} THEN 1 ELSE 0 END)`);
      return this.db.prepare(
        `SELECT ${unsealed.join(" + ")} AS unsealed, ${sealed.length === 0 ? "0" : sealed.join(" + ")} AS sealed
         FROM ${table} WHERE ${owned ? "owner" : "id"} = ?1`,
      ).bind(owner);
    });
    const item = "json_extract(c.value, '$.text')";
    const steps = this.db.prepare(
      `SELECT TOTAL(CASE WHEN NOT ${sealedSql(item)} THEN 1 ELSE 0 END) AS unsealed,
              TOTAL(CASE WHEN ${sealedSql(item)} THEN 1 ELSE 0 END) AS sealed
       FROM task t, json_each(CASE WHEN json_valid(t.checklist) THEN t.checklist ELSE '[]' END) c
       WHERE t.owner = ?1 AND ${item} IS NOT NULL AND ${item} <> ''`,
    ).bind(owner);
    const results = await this.db.batch<Row>([
      ...tables, steps, this.db.prepare(`SELECT encryption FROM account WHERE id = ?`).bind(owner),
    ]);
    let unsealed = 0;
    let sealed = 0;
    for (const r of results.slice(0, tables.length + 1)) {
      unsealed += num(r.results[0]?.unsealed ?? 0);
      sealed += num(r.results[0]?.sealed ?? 0);
    }
    return { state: encryptionOf(results[tables.length + 1]?.results[0]?.encryption), unsealed, sealed };
  }

  async startEncryption(owner: string, to: "on" | "off"): Promise<Outcome<EncryptionReport>> {
    const row = await this.one(`SELECT encryption FROM account WHERE id = ?`, owner);
    if (row === null) return { ok: false, status: 404, error: "this account was not found" };
    const was = encryptionOf(row.encryption);
    if (was !== (to === "on" ? "off" : "on")) {
      return { ok: false, status: 409, error: was === "on" || was === "off" ? `This VEMI is already ${was}.` : "Encryption is already being turned on or off." };
    }
    const res = await this.db.prepare(
      `UPDATE account SET encryption = ?, updated_at = ? WHERE id = ? AND encryption = ?`,
    ).bind(to === "on" ? "turning_on" : "turning_off", this.now(), owner, was).run();
    if ((res.meta.changes ?? 0) === 0) return { ok: false, status: 409, error: "Encryption is already being turned on or off." };
    return { ok: true, value: await this.encryption(owner) };
  }

  async sealBatch(owner: string, records: readonly SealRecord[]): Promise<Outcome<{ readonly written: number }>> {
    if (records.length === 0 || records.length > SEAL_BATCH_MOST) {
      return { ok: false, status: 400, error: `send 1 to ${SEAL_BATCH_MOST} records` };
    }
    const state = await this.stateOf(owner);
    if (state !== "turning_on" && state !== "turning_off") {
      return { ok: false, status: 409, error: "Encryption is not being turned on or off." };
    }
    const sealing = state === "turning_on";
    const wrong = (text: string): boolean => isEnvelopeShape(text) !== sealing;
    const plan: { readonly record: SealRecord; readonly table: string; readonly owned: boolean; readonly sets: Col[] }[] = [];
    for (const record of records) {
      const spec = SEAL_TABLES[record.kind];
      const sets: Col[] = [];
      for (const [field, value] of Object.entries(record.fields)) {
        const column = (spec.columns as Readonly<Record<string, string | undefined>>)[field];
        if (column === undefined) return { ok: false, status: 400, error: `${record.kind} has no sealed field ${field}` };
        if (typeof value === "string") {
          if (wrong(value)) {
            return { ok: false, status: 409, error: sealing ? "Every cell sent while turning on must be sealed." : "Every cell sent while turning off must be plain." };
          }
          if (!sealing && record.kind === "connector_change") {
            try { JSON.parse(value); } catch { return { ok: false, status: 400, error: "before must be JSON once opened" }; }
          }
          sets.push(col(column, value));
        } else {
          if (value.some((item) => wrong(item.text))) {
            return { ok: false, status: 409, error: sealing ? "Every cell sent while turning on must be sealed." : "Every cell sent while turning off must be plain." };
          }
          sets.push(col(column, JSON.stringify(value.map((item) => ({ text: item.text, done: item.done })))));
        }
      }
      plan.push({ record, table: spec.table, owned: spec.owned, sets });
    }
    // One statement per table and slice of the batch, not one per record: the records ride in as JSON,
    // so fifty tasks are one write. A slice is kept under SLICE_CHARS of text so no bound value is large.
    const slices: { table: string; owned: boolean; columns: string[]; rows: Record<string, unknown>[]; size: number }[] = [];
    for (const p of plan) {
      const row: Record<string, unknown> = { id: p.record.id };
      for (const c of p.sets) row[c[0]] = c[2][0];
      const size = JSON.stringify(row).length;
      let slice = slices.find((s) => s.table === p.table && s.size + size <= SEAL_SLICE_CHARS);
      if (slice === undefined) {
        slice = { table: p.table, owned: p.owned, columns: [], rows: [], size: 0 };
        slices.push(slice);
      }
      slice.rows.push(row);
      slice.size += size;
      for (const c of p.sets) if (!slice.columns.includes(c[0])) slice.columns.push(c[0]);
    }
    // Every record must be this owner's before any is written; another's id is not revealed.
    const found = await this.db.batch<Row>(slices.map((s) => this.db.prepare(
      `SELECT id FROM ${s.table} WHERE ${s.owned ? "owner" : "id"} = ?2 AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`,
    ).bind(JSON.stringify(s.rows), owner)));
    for (const [n, result] of found.entries()) {
      const have = new Set(result.results.map((r) => str(r.id)));
      const missing = slices[n]?.rows.find((r) => !have.has(str(r.id)));
      if (missing !== undefined) {
        // Neither the id nor the kind is repeated: another owner's record is not revealed by being named.
        return { ok: false, status: 404, error: "a record in this batch was not found" };
      }
    }
    // The state is checked again inside each write, so a finish in between cannot let an old batch through.
    const res = await this.db.batch(slices.map((s) => this.db.prepare(
      `UPDATE ${s.table} SET ${s.columns.map((c) =>
        `${c} = COALESCE((SELECT json_extract(j.value, '$.${c}') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = ${s.table}.id), ${c})`).join(", ")}
       WHERE ${s.owned ? "owner" : "id"} = ?2 AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))
         AND (SELECT encryption FROM account WHERE id = ?2) = ?3`,
    ).bind(JSON.stringify(s.rows), owner, state)));
    if (res.some((r, n) => (r.meta.changes ?? 0) !== (slices[n]?.rows.length ?? 0))) {
      return { ok: false, status: 409, error: "that changed while it was being written: try again" };
    }
    return { ok: true, value: { written: plan.length } };
  }

  async finishEncryption(owner: string): Promise<Outcome<EncryptionReport>> {
    const report = await this.encryption(owner);
    if (report.state !== "turning_on" && report.state !== "turning_off") {
      return { ok: false, status: 409, error: "Encryption is not being turned on or off." };
    }
    const sealing = report.state === "turning_on";
    const left = sealing ? report.unsealed : report.sealed;
    if (left > 0) return { ok: false, status: 409, error: `${left} ${left === 1 ? "cell is" : "cells are"} not ${sealing ? "sealed" : "opened"} yet.` };
    const next: EncryptionState = sealing ? "on" : "off";
    const res = await this.db.prepare(
      `UPDATE account SET encryption = ?, updated_at = ? WHERE id = ? AND encryption = ?`,
    ).bind(next, this.now(), owner, report.state).run();
    if ((res.meta.changes ?? 0) === 0) return { ok: false, status: 409, error: "that changed while it was being written: try again" };
    return { ok: true, value: { ...report, state: next } };
  }

  async subscribePush(owner: string, sub: NewPushSubscription): Promise<PushSubscriptionSummary> {
    await this.db.prepare(
      `INSERT INTO push_subscription (id, owner, endpoint, p256dh, auth, label, tz, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth,
         label = excluded.label, tz = excluded.tz, archived_at = NULL`,
    ).bind(crypto.randomUUID(), owner, sub.endpoint, sub.p256dh, sub.auth, sub.label, sub.tz, this.now()).run();
    const row = await this.one(
      `SELECT id, endpoint, label, tz, created_at, last_ok_at FROM push_subscription WHERE endpoint = ?`, sub.endpoint,
    );
    return subscriptionFrom(row ?? {});
  }

  async unsubscribePush(owner: string, endpoint: string): Promise<boolean> {
    const res = await this.db.prepare(
      `UPDATE push_subscription SET archived_at = ? WHERE owner = ? AND endpoint = ? AND archived_at IS NULL`,
    ).bind(this.now(), owner, endpoint).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async filters(owner: string): Promise<SavedFilter[]> {
    const rows = await this.db.prepare(
      `SELECT id, name, query, position, created_at FROM saved_filter
       WHERE owner = ? AND archived_at IS NULL ORDER BY position, id`,
    ).bind(owner).all<Row>();
    return rows.results.map(filterFrom);
  }

  async createFilter(owner: string, input: NewSavedFilter): Promise<Outcome<SavedFilter>> {
    const id = input.id ?? crypto.randomUUID();
    if (input.id !== undefined) {
      // The same id sent again is the same filter, so a queued write sent twice makes one.
      const taken = await this.one(`SELECT owner FROM saved_filter WHERE id = ?`, id);
      if (taken !== null) {
        if (taken.owner !== owner) return { ok: false, status: 409, error: `id ${id} is already used by something else` };
        const same = await this.one(`SELECT id, name, query, position, created_at FROM saved_filter WHERE id = ?`, id);
        return { ok: true, value: filterFrom(same ?? {}) };
      }
    }
    const sealed = await this.plainRefused(owner, "savedFilters", { name: input.name, query: input.query });
    if (sealed !== null) return sealed;
    // One statement, so the count and the insert cannot be split by a second request.
    const res = await this.db.prepare(
      `INSERT INTO saved_filter (id, owner, name, query, position, created_at)
       SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(position), 0) + 1, ?5 FROM saved_filter
       WHERE owner = ?2 AND archived_at IS NULL HAVING COUNT(*) < ?6`,
    ).bind(id, owner, input.name, input.query, this.now(), FILTERS_MOST).run();
    if ((res.meta.changes ?? 0) === 0) {
      return { ok: false, status: 409, error: `a person keeps at most ${FILTERS_MOST} saved filters` };
    }
    const row = await this.one(`SELECT id, name, query, position, created_at FROM saved_filter WHERE id = ?`, id);
    return { ok: true, value: filterFrom(row ?? {}) };
  }

  async renameFilter(owner: string, id: string, name: string): Promise<Outcome<SavedFilter>> {
    const sealed = await this.plainRefused(owner, "savedFilters", { name });
    if (sealed !== null) return sealed;
    const res = await this.db.prepare(
      `UPDATE saved_filter SET name = ? WHERE id = ? AND owner = ? AND archived_at IS NULL`,
    ).bind(name, id, owner).run();
    if ((res.meta.changes ?? 0) === 0) return { ok: false, status: 404, error: "that saved filter does not exist" };
    const row = await this.one(`SELECT id, name, query, position, created_at FROM saved_filter WHERE id = ?`, id);
    return { ok: true, value: filterFrom(row ?? {}) };
  }

  async removeFilter(owner: string, id: string): Promise<boolean> {
    const res = await this.db.prepare(
      `UPDATE saved_filter SET archived_at = ? WHERE id = ? AND owner = ? AND archived_at IS NULL`,
    ).bind(this.now(), id, owner).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async registerClient(client: ConnectorClient): Promise<void> {
    await this.db.prepare(
      `INSERT INTO connector_client (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris`,
    ).bind(client.id, client.name, JSON.stringify(client.redirectUris), this.now()).run();
  }

  async client(id: string): Promise<ConnectorClient | null> {
    const row = await this.one(`SELECT * FROM connector_client WHERE id = ?`, id);
    return row === null ? null : clientFrom(row);
  }

  async putCode(owner: string, code: NewConnectorCode): Promise<void> {
    await this.db.prepare(
      `INSERT INTO connector_code (hash, owner, client_id, challenge, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(code.hash, owner, code.clientId, code.challenge, code.redirectUri, code.expiresAt).run();
  }

  async takeCode(hash: string): Promise<ConnectorCode | null> {
    const row = await this.one(`DELETE FROM connector_code WHERE hash = ? RETURNING *`, hash);
    if (row === null || str(row.expires_at) < this.now()) return null;
    return {
      hash: str(row.hash), owner: str(row.owner), clientId: str(row.client_id), challenge: str(row.challenge),
      redirectUri: str(row.redirect_uri), expiresAt: str(row.expires_at),
    };
  }

  async issueGrant(owner: string, grant: NewConnectorTokens & { readonly clientId: string }): Promise<ConnectorGrant> {
    const row = await this.one(
      `INSERT INTO connector_grant (id, owner, client_id, client_name, token_hash, refresh_hash, expires_at, refresh_expires_at, created_at)
       SELECT ?, ?, id, name, ?, ?, ?, ?, ? FROM connector_client WHERE id = ? RETURNING *`,
      crypto.randomUUID(), owner, grant.tokenHash, grant.refreshHash, grant.expiresAt, daysFrom(this.clock(), REFRESH_DAYS), this.now(), grant.clientId,
    );
    if (row === null) throw new Error(`connector client ${grant.clientId} is not registered`);
    return grantFrom(row);
  }

  async grantByToken(tokenHash: string): Promise<ConnectorGrant | null> {
    const at = this.now();
    const row = await this.one(
      `UPDATE connector_grant SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL AND expires_at >= ? RETURNING *`,
      at, tokenHash, at,
    );
    return row === null ? null : grantFrom(row);
  }

  async rotateGrant(refreshHash: string, clientId: string, next: NewConnectorTokens): Promise<ConnectorGrant | null> {
    const row = await this.one(
      `UPDATE connector_grant SET token_hash = ?, refresh_hash = ?, expires_at = ?, refresh_expires_at = ?
       WHERE refresh_hash = ? AND client_id = ? AND revoked_at IS NULL AND refresh_expires_at >= ? RETURNING *`,
      next.tokenHash, next.refreshHash, next.expiresAt, daysFrom(this.clock(), REFRESH_DAYS), refreshHash, clientId, this.now(),
    );
    return row === null ? null : grantFrom(row);
  }

  async grants(owner: string): Promise<ConnectorGrant[]> {
    const rows = await this.db.prepare(
      `SELECT * FROM connector_grant WHERE owner = ? AND revoked_at IS NULL ORDER BY created_at, id`,
    ).bind(owner).all<Row>();
    return rows.results.map(grantFrom);
  }

  async revokeGrant(owner: string, id: string): Promise<boolean> {
    const res = await this.db.prepare(
      `UPDATE connector_grant SET revoked_at = ? WHERE id = ? AND owner = ? AND revoked_at IS NULL`,
    ).bind(this.now(), id, owner).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async purgeConnector(): Promise<{ readonly codes: number; readonly grants: number; readonly clients: number }> {
    const now = this.now();
    // In this order, so an app whose last grant went in this run is judged after it.
    const [codes, grants, clients] = await this.db.batch([
      this.db.prepare(`DELETE FROM connector_code WHERE expires_at < ?`).bind(now),
      this.db.prepare(
        `DELETE FROM connector_grant WHERE refresh_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      ).bind(now, daysFrom(this.clock(), -REVOKED_KEPT_DAYS)),
      this.db.prepare(
        `DELETE FROM connector_client WHERE created_at < ?
           AND NOT EXISTS (SELECT 1 FROM connector_grant g WHERE g.client_id = connector_client.id)
           AND NOT EXISTS (SELECT 1 FROM connector_code c WHERE c.client_id = connector_client.id)`,
      ).bind(daysFrom(this.clock(), -1)),
    ]);
    return { codes: codes?.meta.changes ?? 0, grants: grants?.meta.changes ?? 0, clients: clients?.meta.changes ?? 0 };
  }

  async recordChange(owner: string, change: NewConnectorChange): Promise<ConnectorChange> {
    const row = await this.one(
      `INSERT INTO connector_change (id, owner, grant_id, client_name, tool, kind, record_id, before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      crypto.randomUUID(), owner, change.grantId, change.clientName, change.tool, change.kind, change.recordId,
      change.before === null ? null : JSON.stringify(change.before), this.now(),
    );
    return changeFrom(row ?? {});
  }

  async changes(owner: string, since: string): Promise<ConnectorChange[]> {
    const rows = await this.db.prepare(
      `SELECT * FROM connector_change WHERE owner = ? AND created_at >= ? ORDER BY created_at DESC, id`,
    ).bind(owner, since).all<Row>();
    return rows.results.map(changeFrom);
  }

  async change(owner: string, id: string): Promise<ConnectorChange | null> {
    const row = await this.one(`SELECT * FROM connector_change WHERE id = ? AND owner = ?`, id, owner);
    return row === null ? null : changeFrom(row);
  }

  async markChangeUndone(owner: string, id: string): Promise<boolean> {
    const res = await this.db.prepare(
      `UPDATE connector_change SET undone_at = ? WHERE id = ? AND owner = ? AND undone_at IS NULL`,
    ).bind(this.now(), id, owner).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async pushSubscriptions(owner: string): Promise<PushSubscriptionSummary[]> {
    const rows = await this.db.prepare(
      `SELECT id, endpoint, label, tz, created_at, last_ok_at FROM push_subscription
       WHERE owner = ? AND archived_at IS NULL ORDER BY created_at, id`,
    ).bind(owner).all<Row>();
    return rows.results.map(subscriptionFrom);
  }

  async reminderAccounts(): Promise<ReminderAccount[]> {
    const rows = await this.db.prepare(
      `SELECT a.id AS owner, a.remind_morning, a.remind_tasks, a.quiet_from, a.quiet_to, a.encryption,
         COALESCE(a.time_zone, (SELECT p.tz FROM push_subscription p WHERE p.owner = a.id AND p.archived_at IS NULL
            ORDER BY p.created_at DESC, p.id DESC LIMIT 1)) AS tz
       FROM account a
       WHERE (a.remind_tasks = 1 OR a.remind_morning IS NOT NULL)
         AND EXISTS (SELECT 1 FROM push_subscription p WHERE p.owner = a.id AND p.archived_at IS NULL)
       ORDER BY a.id`,
    ).all<Row>();
    return rows.results.map((r) => ({
      owner: str(r.owner),
      tz: typeof r.tz === "string" ? r.tz : null,
      encryption: encryptionOf(r.encryption),
      settings: {
        morningAt: typeof r.remind_morning === "string" ? r.remind_morning : null,
        taskReminders: num(r.remind_tasks) === 1,
        quietFrom: typeof r.quiet_from === "string" ? r.quiet_from : null,
        quietTo: typeof r.quiet_to === "string" ? r.quiet_to : null,
      },
    }));
  }

  async pushDevices(owner: string): Promise<PushDevice[]> {
    const rows = await this.db.prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscription
       WHERE owner = ? AND archived_at IS NULL ORDER BY created_at, id`,
    ).bind(owner).all<Row>();
    return rows.results.map((r) => ({ id: str(r.id), endpoint: str(r.endpoint), p256dh: str(r.p256dh), auth: str(r.auth) }));
  }

  async dueReminders(owner: string, from: string, to: string, limit: number): Promise<DueReminder[]> {
    const rows = await this.db.prepare(
      `SELECT t.id, t.title, t.remind_at FROM task t LEFT JOIN state s ON s.id = t.state_id
       WHERE t.owner = ?1 AND ${taskVisible("t")} AND ${NOT_FINISHED("s.kind")}
         AND t.remind_at IS NOT NULL AND t.remind_at >= ?2 AND t.remind_at <= ?3
         AND NOT EXISTS (SELECT 1 FROM reminder_sent r WHERE r.owner = ?1 AND r.kind = 'task'
                           AND r.ref = t.id AND r.at = t.remind_at AND r.archived_at IS NULL)
       ORDER BY t.remind_at, t.id LIMIT ?4`,
    ).bind(owner, from, to, limit).all<Row>();
    return rows.results.map((r) => ({ taskId: str(r.id), title: str(r.title), remindAt: str(r.remind_at) }));
  }

  async reminderWasSent(owner: string, kind: string, ref: string, at: string): Promise<boolean> {
    return (await this.one(
      `SELECT 1 AS yes FROM reminder_sent WHERE owner = ? AND kind = ? AND ref = ? AND at = ? AND archived_at IS NULL`,
      owner, kind, ref, at,
    )) !== null;
  }

  async recordReminderSent(owner: string, kind: string, ref: string, at: string): Promise<void> {
    await this.db.prepare(`INSERT OR IGNORE INTO reminder_sent (owner, kind, ref, at) VALUES (?, ?, ?, ?)`)
      .bind(owner, kind, ref, at).run();
  }

  async pushWorked(owner: string, deviceId: string): Promise<void> {
    await this.db.prepare(`UPDATE push_subscription SET last_ok_at = ? WHERE id = ? AND owner = ?`).bind(this.now(), deviceId, owner).run();
  }

  async vapidKey(): Promise<StoredVapidKey | null> {
    const row = await this.one(`SELECT public_key, private_key FROM vapid_key WHERE id = 1`);
    return row === null ? null : { publicKey: str(row.public_key), privateKey: str(row.private_key) };
  }

  async keepVapidKey(key: StoredVapidKey): Promise<StoredVapidKey> {
    await this.db.prepare(
      `INSERT OR IGNORE INTO vapid_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)`,
    ).bind(key.publicKey, key.privateKey, this.now()).run();
    return (await this.vapidKey()) ?? key;
  }

  async sessionKey(): Promise<string | null> {
    const row = await this.one(`SELECT secret FROM session_key WHERE id = 1`);
    return row === null ? null : str(row.secret);
  }

  async keepSessionKey(secret: string): Promise<string> {
    await this.db.prepare(`INSERT OR IGNORE INTO session_key (id, secret, created_at) VALUES (1, ?, ?)`)
      .bind(secret, this.now()).run();
    return (await this.sessionKey()) ?? secret;
  }

  async setupClaim(): Promise<SetupClaim | null> {
    const row = await this.one(`SELECT claimed_at, sealed_token, keep_updated FROM setup_claim WHERE id = 1`);
    if (row === null) return null;
    return {
      claimedAt: str(row.claimed_at),
      sealedToken: row.sealed_token === null ? null : str(row.sealed_token),
      keepUpdated: num(row.keep_updated) === 1,
    };
  }

  async keepSetupClaim(sealedToken: string | null, keepUpdated: boolean): Promise<{ claim: SetupClaim; made: boolean }> {
    const at = this.now();
    const res = await this.db.prepare(
      `INSERT OR IGNORE INTO setup_claim (id, claimed_at, sealed_token, keep_updated, created_at) VALUES (1, ?, ?, ?, ?)`,
    ).bind(at, sealedToken, keepUpdated ? 1 : 0, at).run();
    const claim = (await this.setupClaim()) ?? { claimedAt: at, sealedToken, keepUpdated };
    return { claim, made: (res.meta.changes ?? 0) > 0 };
  }

  async updateCheck(): Promise<UpdateCheckRecord | null> {
    const row = await this.one(`SELECT version, manifest, signature, checked_at, archived_at, issued_at FROM update_offer WHERE id = 1`);
    if (row === null) return null;
    const kept = row.archived_at === null && row.version !== null && row.manifest !== null && row.signature !== null;
    return {
      issuedAt: optStr(row.issued_at),
      checkedAt: str(row.checked_at),
      offer: kept ? { version: str(row.version), manifest: str(row.manifest), signature: str(row.signature) } : null,
    };
  }

  async keepUpdateCheck(offer: UpdateOffer | null, issuedAt: string | null = null): Promise<UpdateCheckRecord> {
    const at = this.now();
    // The kept issue date only ever moves forward, so a played-back older feed cannot lower it.
    await this.db.prepare(
      `INSERT INTO update_offer (id, version, manifest, signature, checked_at, created_at, archived_at, issued_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, manifest = excluded.manifest, signature = excluded.signature,
         checked_at = excluded.checked_at, archived_at = excluded.archived_at,
         issued_at = CASE WHEN excluded.issued_at IS NOT NULL AND (update_offer.issued_at IS NULL OR excluded.issued_at > update_offer.issued_at)
                          THEN excluded.issued_at ELSE update_offer.issued_at END`,
    ).bind(offer?.version ?? null, offer?.manifest ?? null, offer?.signature ?? null, at, at, offer === null ? at : null, issuedAt).run();
    return { checkedAt: at, offer, issuedAt: (await this.updateCheck())?.issuedAt ?? issuedAt };
  }

  async updateRun(): Promise<UpdateRun | null> {
    const row = await this.one(
      `SELECT version, step, state, account_id, database_id, worker_name, previous_version_id, previous_version, new_version_id, bookmark,
              migrated, started_at, updated_at, back_until FROM update_run WHERE id = 1 AND archived_at IS NULL`,
    );
    if (row === null) return null;
    return {
      version: str(row.version), step: str(row.step), state: str(row.state),
      accountId: optStr(row.account_id), databaseId: optStr(row.database_id), workerName: optStr(row.worker_name),
      previousVersionId: optStr(row.previous_version_id), previousVersion: optStr(row.previous_version), newVersionId: optStr(row.new_version_id),
      bookmark: optStr(row.bookmark), migrated: num(row.migrated),
      startedAt: str(row.started_at), updatedAt: str(row.updated_at), backUntil: optStr(row.back_until),
    };
  }

  async keepUpdateRun(run: Omit<UpdateRun, "updatedAt">): Promise<UpdateRun> {
    const at = this.now();
    await this.db.prepare(
      `INSERT INTO update_run (id, version, step, state, account_id, database_id, worker_name, previous_version_id, previous_version, new_version_id,
         bookmark, migrated, started_at, updated_at, back_until, created_at, archived_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, step = excluded.step, state = excluded.state,
         account_id = excluded.account_id, database_id = excluded.database_id, worker_name = excluded.worker_name,
         previous_version_id = excluded.previous_version_id, previous_version = excluded.previous_version, new_version_id = excluded.new_version_id,
         bookmark = excluded.bookmark, migrated = excluded.migrated, started_at = excluded.started_at,
         updated_at = excluded.updated_at, back_until = excluded.back_until, archived_at = NULL`,
    ).bind(run.version, run.step, run.state, run.accountId, run.databaseId, run.workerName, run.previousVersionId, run.previousVersion,
      run.newVersionId, run.bookmark, run.migrated, run.startedAt, at, run.backUntil, at).run();
    return { ...run, updatedAt: at };
  }

  async openUpdateRun(run: Omit<UpdateRun, "updatedAt">): Promise<boolean> {
    const at = this.now();
    const lapsed = new Date(Date.parse(at) - UPDATE_RUN_OPEN_MS).toISOString();
    const res = await this.db.prepare(
      `INSERT INTO update_run (id, version, step, state, account_id, database_id, worker_name, previous_version_id, previous_version, new_version_id,
         bookmark, migrated, started_at, updated_at, back_until, created_at, archived_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, step = excluded.step, state = excluded.state,
         account_id = excluded.account_id, database_id = excluded.database_id, worker_name = excluded.worker_name,
         previous_version_id = excluded.previous_version_id, previous_version = excluded.previous_version, new_version_id = excluded.new_version_id,
         bookmark = excluded.bookmark, migrated = excluded.migrated, started_at = excluded.started_at,
         updated_at = excluded.updated_at, back_until = excluded.back_until, archived_at = NULL
       WHERE update_run.state IN ('done', 'back') OR update_run.archived_at IS NOT NULL OR update_run.updated_at < ?`,
    ).bind(run.version, run.step, run.state, run.accountId, run.databaseId, run.workerName, run.previousVersionId, run.previousVersion,
      run.newVersionId, run.bookmark, run.migrated, run.startedAt, at, run.backUntil, at, lapsed).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async takeUpdateStep(step: string): Promise<boolean> {
    const at = this.now();
    const lapsed = new Date(Date.parse(at) - UPDATE_STEP_HOLD_MS).toISOString();
    const res = await this.db.prepare(
      `UPDATE update_run SET state = 'busy', updated_at = ?
       WHERE id = 1 AND archived_at IS NULL AND step = ? AND (state <> 'busy' OR updated_at < ?)`,
    ).bind(at, step, lapsed).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async expireUpdateCheck(): Promise<void> {
    await this.db.prepare(`UPDATE update_offer SET checked_at = ? WHERE id = 1`).bind("1970-01-01T00:00:00.000Z").run();
  }

  async removeSetupKey(): Promise<boolean> {
    // The row stays, spent: its presence is what says the copy was claimed, so the setup code cannot claim it again.
    const res = await this.db.prepare(
      `UPDATE setup_claim SET sealed_token = NULL, keep_updated = 0 WHERE id = 1 AND (sealed_token IS NOT NULL OR keep_updated <> 0)`,
    ).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async frontLanding(): Promise<boolean> {
    const row = await this.one(`SELECT landing FROM front_setting WHERE id = 1`);
    return row === null ? true : num(row.landing) === 1;
  }

  async setFrontLanding(landing: boolean): Promise<boolean> {
    await this.db.prepare(
      `INSERT INTO front_setting (id, landing, created_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET landing = excluded.landing`,
    ).bind(landing ? 1 : 0, this.now()).run();
    return this.frontLanding();
  }

  async canvas(owner: string): Promise<CanvasPosition[]> {
    const rows = await this.db.prepare(`SELECT kind, id, x, y FROM canvas_pos WHERE owner = ? ORDER BY kind, id`)
      .bind(owner).all<Row>();
    return rows.results.map((r) => ({ kind: str(r.kind) as CanvasPosition["kind"], id: str(r.id), x: num(r.x), y: num(r.y) }));
  }

  async setCanvas(owner: string, positions: readonly CanvasPosition[]): Promise<Outcome<CanvasPosition[]>> {
    // A box is placed only if the account owns the space or project it stands for.
    const known = await this.db.batch<Row>(positions.map((p) =>
      this.db.prepare(`SELECT id FROM ${p.kind} WHERE id = ? AND owner = ?`).bind(p.id, owner)));
    const missing = positions.find((_, n) => (known[n]?.results.length ?? 0) === 0);
    if (missing !== undefined) return { ok: false, status: 404, error: `a ${missing.kind} in the list is not in this account` };
    if (positions.length > 0) {
      await this.db.batch(positions.map((p) => this.db.prepare(
        `INSERT INTO canvas_pos (owner, kind, id, x, y) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner, kind, id) DO UPDATE SET x = excluded.x, y = excluded.y`,
      ).bind(owner, p.kind, p.id, p.x, p.y)));
    }
    return { ok: true, value: await this.canvas(owner) };
  }

  async accountsForGoogle(sub: string, email: string): Promise<AccountSecret[]> {
    const rows = await this.db.prepare(`SELECT * FROM account WHERE google_sub = ? OR email = ? ORDER BY created_at, id`)
      .bind(sub, normalEmail(email)).all<Row>();
    return rows.results.map(accountFrom);
  }

  async createAccount(account: NewAccount): Promise<boolean> {
    const at = this.now();
    try {
      await this.db.batch([
        this.db.prepare(`INSERT OR IGNORE INTO tenant (id, created_at) VALUES (?, ?)`).bind(account.id, at),
        this.db.prepare(
          `INSERT INTO account (id, email, email_confirmed_at, password_hash, google_sub, created_at, updated_at, first_run_step, tips_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, '[]')`,
        ).bind(account.id, account.email, account.confirmed ? at : null, account.passwordHash, account.googleSub, at, at),
      ]);
      return true;
    } catch (e) {
      if (isUnique(e)) return false;
      throw e;
    }
  }

  async setPassword(owner: string, passwordHash: string, confirm: boolean): Promise<number | null> {
    const at = this.now();
    const row = await this.one(
      `UPDATE account SET password_hash = ?, session_generation = session_generation + 1, updated_at = ?,
         email_confirmed_at = CASE WHEN ? THEN COALESCE(email_confirmed_at, ?) ELSE email_confirmed_at END
       WHERE id = ? RETURNING session_generation`,
      passwordHash, at, confirm ? 1 : 0, at, owner,
    );
    return row === null ? null : num(row.session_generation);
  }

  async endSessions(owner: string): Promise<number | null> {
    const row = await this.one(
      `UPDATE account SET session_generation = session_generation + 1, updated_at = ? WHERE id = ? RETURNING session_generation`,
      this.now(), owner,
    );
    return row === null ? null : num(row.session_generation);
  }

  async setTwoStep(owner: string, state: TwoStepState): Promise<boolean> {
    const at = this.now();
    const result = await this.db.prepare(
      `UPDATE account SET two_step_secret = ?, two_step_on_at = ?, backup_codes = ?, totp_last_step = NULL, updated_at = ? WHERE id = ?`,
    ).bind(state.secret, state.on ? at : null, JSON.stringify(state.backupCodes), at, owner).run();
    return result.meta.changes > 0;
  }

  async acceptTotpStep(owner: string, step: number): Promise<boolean> {
    // One statement, so two requests with the same code cannot both win.
    const result = await this.db.prepare(
      `UPDATE account SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
    ).bind(step, owner, step).run();
    return result.meta.changes > 0;
  }

  async spendBackupCode(owner: string, hash: string): Promise<boolean> {
    const row = await this.one(`SELECT backup_codes FROM account WHERE id = ?`, owner);
    if (row === null) return false;
    const kept = backupCodesFrom(row.backup_codes);
    if (!kept.includes(hash)) return false;
    // Only the request that still sees the list it read can write the shorter one.
    const result = await this.db.prepare(`UPDATE account SET backup_codes = ?, updated_at = ? WHERE id = ? AND backup_codes = ?`)
      .bind(JSON.stringify(kept.filter((c) => c !== hash)), this.now(), owner, str(row.backup_codes)).run();
    return result.meta.changes > 0;
  }

  async setRecoveryCode(owner: string, hash: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO recovery_code (owner, code_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT (owner) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at`,
    ).bind(owner, hash, this.now()).run();
  }

  async spendRecoveryCode(owner: string, hash: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM recovery_code WHERE owner = ? AND code_hash = ?`).bind(owner, hash).run();
    return result.meta.changes > 0;
  }

  async linkGoogle(owner: string, sub: string): Promise<boolean> {
    try {
      const result = await this.db.prepare(`UPDATE account SET google_sub = ?, updated_at = ? WHERE id = ?`)
        .bind(sub, this.now(), owner).run();
      return result.meta.changes > 0;
    } catch (e) {
      if (isUnique(e)) return false;
      throw e;
    }
  }

  async unlinkGoogle(owner: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE account SET google_sub = NULL, updated_at = ? WHERE id = ? AND password_hash IS NOT NULL AND google_sub IS NOT NULL`,
    ).bind(this.now(), owner).run();
    return result.meta.changes > 0;
  }

  async sessionHolds(owner: string, generation: number): Promise<SessionState> {
    return sessionState(await this.one(SESSION_ROW, owner), generation);
  }

  readingAs(owner: string, generation: number): SessionRead {
    const db = this.db;
    /** The first round trip, which carries the session's row as its first result. */
    let first: Promise<D1Result<Row>[]> | null = null;
    const along = async (statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> => {
      if (first !== null) return statements.length === 0 ? [] : db.batch<Row>(statements);
      first = db.batch<Row>([db.prepare(SESSION_ROW).bind(owner), ...statements]);
      return (await first).slice(1);
    };
    // Handed out as the binding's own statements, so every read path runs unchanged. Each
    // keeps the real one, which is what a batch is sent.
    const statement = (inner: D1PreparedStatement): D1PreparedStatement => ({
      [REAL]: inner,
      bind: (...values: unknown[]) => statement(inner.bind(...values)),
      first: async (column?: string) => {
        if (first !== null) return column === undefined ? inner.first() : inner.first(column);
        const row = (await along([inner]))[0]?.results[0];
        return row === undefined ? null : column === undefined ? row : row[column] ?? null;
      },
      all: async () => (first !== null ? inner.all() : (await along([inner]))[0]),
      run: async () => (first !== null ? inner.run() : (await along([inner]))[0]),
      raw: async (options?: { columnNames?: boolean }) => {
        await along([]);
        return inner.raw(options as { columnNames: true });
      },
    }) as unknown as D1PreparedStatement;
    const real = (s: D1PreparedStatement): D1PreparedStatement =>
      (s as unknown as { [REAL]?: D1PreparedStatement })[REAL] ?? s;
    const reading = {
      prepare: (sql: string) => statement(db.prepare(sql)),
      batch: (statements: D1PreparedStatement[]) => along(statements.map(real)),
    } as unknown as D1Database;
    return {
      store: new D1Store(reading, this.clock),
      holds: async () => {
        await along([]);
        const [session] = await (first as unknown as Promise<D1Result<Row>[]>);
        return sessionState(session?.results[0] ?? null, generation);
      },
    };
  }

  async putEmailToken(token: EmailToken): Promise<void> {
    const at = this.now();
    await this.db.batch([
      this.db.prepare(`DELETE FROM email_token WHERE expires_at < ?`).bind(at),
      // An invitation sent again to the same address replaces the one before it.
      this.db.prepare(`DELETE FROM email_token WHERE owner = ? AND purpose = 'invite' AND email = ? AND ? = 'invite'`)
        .bind(token.owner, token.email, token.purpose),
      // A move code replaces the account's earlier one, which is spent by it.
      this.db.prepare(`DELETE FROM email_token WHERE owner = ? AND purpose = 'confirm' AND email = ? AND ? = 'confirm' AND ? = ?`)
        .bind(token.owner, MOVE_CODE_MARK, token.purpose, token.email, MOVE_CODE_MARK),
      this.db.prepare(`INSERT INTO email_token (id, owner, purpose, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(token.id, token.owner, token.purpose, token.email, token.expiresAt, at),
    ]);
  }

  async takeEmailToken(id: string, purpose: TokenPurpose): Promise<EmailToken | null> {
    const row = await this.one(`DELETE FROM email_token WHERE id = ? AND purpose = ? RETURNING *`, id, purpose);
    if (row === null) return null;
    const token = tokenFrom(row);
    return token.expiresAt < this.now() ? null : token;
  }

  async pendingToken(id: string, purpose: TokenPurpose): Promise<EmailToken | null> {
    const row = await this.one(`SELECT * FROM email_token WHERE id = ? AND purpose = ? AND expires_at >= ?`, id, purpose, this.now());
    return row === null ? null : tokenFrom(row);
  }

  async acceptInvite(id: string, account: Pick<NewAccount, "id" | "passwordHash" | "googleSub">) {
    const at = this.now();
    // Every statement reads the invitation the same way, so either all of them act or none
    // does, and the last spends it. A unique clash fails the batch, which takes the tenant
    // and the spending back with it.
    const offered = `FROM email_token WHERE id = ? AND purpose = 'invite' AND expires_at >= ?`;
    try {
      const [, made] = await this.db.batch<Row>([
        this.db.prepare(`INSERT OR IGNORE INTO tenant (id, created_at) SELECT ?, ? ${offered}`).bind(account.id, at, id, at),
        this.db.prepare(
          `INSERT INTO account (id, email, email_confirmed_at, password_hash, google_sub, created_at, updated_at, first_run_step, tips_seen)
           SELECT ?, email, ?, ?, ?, ?, ?, 1, '[]' ${offered} RETURNING email`,
        ).bind(account.id, at, account.passwordHash, account.googleSub, at, at, id, at),
        this.db.prepare(`DELETE FROM email_token WHERE id = ? AND purpose = 'invite'`).bind(id),
      ]);
      const email = made?.results[0]?.email;
      return email === undefined ? { made: false as const, why: "invalid" as const } : { made: true as const, email: str(email) };
    } catch (e) {
      if (isUnique(e)) return { made: false as const, why: "taken" as const };
      throw e;
    }
  }

  async withdrawInvite(owner: string, email: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM email_token WHERE owner = ? AND purpose = 'invite' AND email = ?`)
      .bind(owner, normalEmail(email)).run();
    return result.meta.changes > 0;
  }

  async putInvite(invite: { readonly id: string; readonly owner: string; readonly firstName: string; readonly expiresAt: string }): Promise<void> {
    await this.db.prepare(`INSERT INTO invite (id, owner, first_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(invite.id, invite.owner, invite.firstName, invite.expiresAt, this.now()).run();
  }

  async people(owner: string): Promise<People> {
    const [joined, waiting] = await this.db.batch<Row>([
      this.db.prepare(
        `SELECT a.id, a.first_name, a.email, a.delete_on FROM invite i JOIN account a ON a.id = i.accepted_by
         WHERE i.owner = ? AND i.used_at IS NOT NULL AND i.archived_at IS NULL ORDER BY i.used_at, a.id`,
      ).bind(owner),
      this.db.prepare(
        `SELECT id, first_name, expires_at FROM invite
         WHERE owner = ? AND used_at IS NULL AND archived_at IS NULL AND expires_at >= ? ORDER BY created_at, id`,
      ).bind(owner, this.now()),
    ]);
    return {
      people: (joined?.results ?? []).map((r) => ({ id: str(r.id), firstName: optStr(r.first_name), email: str(r.email), deleteOn: optStr(r.delete_on) })),
      invites: (waiting?.results ?? []).map((r) => ({ id: str(r.id), firstName: str(r.first_name), expiresAt: str(r.expires_at) })),
    };
  }

  async withdrawPersonInvite(owner: string, id: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE invite SET archived_at = ? WHERE id = ? AND owner = ? AND used_at IS NULL AND archived_at IS NULL`,
    ).bind(this.now(), id, owner).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async removePerson(owner: string, id: string): Promise<Outcome<{ readonly deleteOn: string }>> {
    const theirs = await this.one(
      `SELECT 1 AS found FROM invite WHERE owner = ? AND accepted_by = ? AND used_at IS NOT NULL AND archived_at IS NULL`,
      owner, id,
    );
    if (theirs === null) return { ok: false, status: 404, error: "no such person" };
    return this.scheduleDeletion(id);
  }

  async pendingPersonInvite(id: string): Promise<{ readonly firstName: string } | null> {
    const row = await this.one(
      `SELECT first_name FROM invite WHERE id = ? AND used_at IS NULL AND archived_at IS NULL AND expires_at >= ?`,
      id, this.now(),
    );
    return row === null ? null : { firstName: str(row.first_name) };
  }

  async acceptPersonInvite(id: string, account: Pick<NewAccount, "id" | "email" | "passwordHash" | "googleSub">) {
    const at = this.now();
    // Every statement reads the invitation the same way, so either all of them act or none does,
    // and the last marks it used. A unique clash fails the batch and takes the rest back with it.
    const offered = `FROM invite WHERE id = ? AND used_at IS NULL AND archived_at IS NULL AND expires_at >= ?`;
    try {
      const [, made] = await this.db.batch<Row>([
        this.db.prepare(`INSERT OR IGNORE INTO tenant (id, created_at) SELECT ?, ? ${offered}`).bind(account.id, at, id, at),
        this.db.prepare(
          `INSERT INTO account (id, email, email_confirmed_at, password_hash, google_sub, first_name, created_at, updated_at, first_run_step, tips_seen)
           SELECT ?, ?, ?, ?, ?, first_name, ?, ?, 1, '[]' ${offered} RETURNING id`,
        ).bind(account.id, account.email, at, account.passwordHash, account.googleSub, at, at, id, at),
        this.db.prepare(`UPDATE invite SET used_at = ?, accepted_by = ? WHERE id = ? AND used_at IS NULL AND archived_at IS NULL AND expires_at >= ?`)
          .bind(at, account.id, id, at),
      ]);
      return made?.results[0] === undefined ? { made: false as const, why: "invalid" as const } : { made: true as const };
    } catch (e) {
      if (isUnique(e)) return { made: false as const, why: "taken" as const };
      throw e;
    }
  }

  async invites(owner: string): Promise<EmailToken[]> {
    const rows = await this.db.prepare(
      `SELECT * FROM email_token WHERE owner = ? AND purpose = 'invite' AND expires_at >= ? ORDER BY created_at, id`,
    ).bind(owner, this.now()).all<Row>();
    return rows.results.map(tokenFrom);
  }

  /**
   * Mirrors the schema instead of mapping it: table and column names are read straight off
   * `sqlite_master` rather than going through `TABLE`/`MAP`, so a new owned table or column
   * is exported with no change here.
   *
   * D1's authorizer refuses `pragma_table_info` the moment its argument is not a constant —
   * a join or an `EXISTS` correlated to `sqlite_master.name` both fail closed with
   * `SQLITE_AUTH`, verified against a real binding rather than assumed. So "has an owner
   * column" is read off each table's own `CREATE TABLE` text (the `sql` column
   * `sqlite_master` already carries): every column
   * in this schema sits on its own line, `<name> <TYPE> ...`, which is exactly what
   * `OWNER_COLUMN` matches. Two round trips: one `all()` to read every table's schema text,
   * one `batch()` of one `SELECT` per table kept after `EXPORT_EXCLUDED` is subtracted.
   */
  async exportAll(owner: string, now: Date): Promise<ExportDocument> {
    const master = await this.db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`,
    ).all<Row>();
    const tableNames = master.results
      .filter((r) => OWNER_COLUMN.test(str(r.sql)))
      .map((r) => str(r.name))
      .filter((name) => !EXPORT_EXCLUDED.includes(name))
      .sort();

    // The tables and the account's settings, in one round trip.
    const results = await this.db.batch<Row>([
      ...tableNames.map((name) => this.db.prepare(`SELECT * FROM "${name}" WHERE owner = ?${EXPORT_ROW_FILTER[name] ?? ""}`).bind(owner)),
      this.db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM account WHERE id = ?`).bind(owner),
    ]);
    const settingsRow = results[tableNames.length]?.results[0];

    const tables: Record<string, Row[]> = {};
    for (const [n, name] of tableNames.entries()) {
      const cut = CUT_COLUMNS[name] ?? [];
      tables[name] = (results[n]?.results ?? []).map((row) => {
        const { owner: _owner, ...rest } = row;
        for (const column of cut) delete rest[column];
        return rest;
      });
    }

    return {
      format: "vemi-export",
      version: 2,
      exportedAt: now.toISOString(),
      settings: { ...(settingsRow === undefined ? NO_SETTINGS : appearanceFrom(settingsRow)) },
      about:
        "Everything this account made in VEMI, one key per table, exactly as stored. " +
        "`venture` is the map; `state` names a venture's board columns; " +
        "`stage` names a venture's lifecycle stages, and `venture` and `project` carry `stage_id` and `at_risk`; " +
        "`project`, `milestone`, `task`, `blocker` and `note` sit inside a " +
        "venture; `link` sits on a venture, a project or a task, with a role; `decision` and `risk` are recorded against a venture or a project; `tag` is a name, and `task_tag`/`project_tag` say which task or project " +
        "carries it. Archived rows are included, marked by a non-null `archived_at`. Left " +
        "out on purpose: sign-in credentials, recovery codes and backup history, never " +
        "something a person made. `settings` is what the account chose for its copy.",
      tables,
    };
  }

  /** Every table with an owner column, read off the schema, with its columns and the keys it names. */
  private async ownedTables(): Promise<OwnedTable[]> {
    const master = await this.db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`,
    ).all<Row>();
    const names = master.results
      .filter((r) => OWNER_COLUMN.test(str(r.sql)) && /^[a-z_]+$/i.test(str(r.name)))
      .map((r) => str(r.name))
      .sort();
    if (names.length === 0) return [];
    // A constant name in each pragma, as D1's authorizer requires; the names passed the check above.
    const results = await this.db.batch<Row>(names.flatMap((name) => [
      this.db.prepare(`SELECT name, pk FROM pragma_table_info('${name}')`),
      this.db.prepare(`SELECT "from" AS column_name, "table" AS target FROM pragma_foreign_key_list('${name}')`),
    ]));
    return names.map((name, n) => {
      const info = results[2 * n]?.results ?? [];
      const keys = results[2 * n + 1]?.results ?? [];
      const primary = info.filter((c) => num(c.pk) > 0).map((c) => str(c.name));
      return {
        name,
        columns: info.map((c) => str(c.name)),
        ownId: primary.length === 1 && primary[0] === "id",
        refs: keys.map((k) => ({ column: str(k.column_name), table: str(k.target) })),
      };
    });
  }

  async restoreAll(owner: string, file: RestoreFile): Promise<Outcome<{
    readonly counts: Record<string, number>; readonly locked: RestoredLock[]; readonly ids: Record<string, string>;
  }>> {
    const planned = await this.planRestore(owner, file);
    if (!planned.ok) return planned;
    try {
      await this.db.batch(planned.value.statements);
    } catch {
      return { ok: false, status: 400, error: "This file does not fit this copy, so nothing was changed." };
    }
    const { counts, locked, ids } = planned.value;
    return { ok: true, value: { counts, locked, ids } };
  }

  async checkRestore(file: RestoreFile, owner = ""): Promise<Outcome<{ readonly counts: Record<string, number> }>> {
    // Nothing is written. With no owner, no account holds this yet and nothing is read for one.
    const planned = await this.planRestore(owner, file);
    return planned.ok ? { ok: true, value: { counts: planned.value.counts } } : planned;
  }

  /** Every refusal a restore has, and the statements that would carry it out. Writes nothing. */
  private async planRestore(owner: string, file: RestoreFile): Promise<Outcome<{
    readonly counts: Record<string, number>; readonly locked: RestoredLock[]; readonly ids: Record<string, string>;
    readonly statements: D1PreparedStatement[];
  }>> {
    const refuse = (error: string): Outcome<never> => ({ ok: false, status: 400, error });
    // Nothing is changed for a file the account could not hold: while on, every typed cell must already be an envelope.
    const sealedOnly = (await this.stateOf(owner)) === "on";
    const owned = await this.ownedTables();
    const kept = new Set([...EXPORT_EXCLUDED, ...RESTORE_KEPT]);
    const restorable = owned.filter((t) => !kept.has(t.name));
    const byName = new Map(restorable.map((t) => [t.name, t]));
    for (const name of Object.keys(file.tables)) {
      // A file always carries the device tables; a restore leaves them where they are.
      if (CUT_TABLES.includes(name)) continue;
      if (!byName.has(name) && !RESTORE_KEPT.includes(name)) return refuse(`This file holds ${name}, which this copy does not know.`);
    }

    // Every record gets a new id, so a file from another account, or from this one, never meets an id already in use.
    const fresh = new Map<string, string>();
    for (const t of restorable) {
      if (!t.ownId) continue;
      for (const row of file.tables[t.name] ?? []) {
        const old = row.id;
        if (typeof old !== "string" || old === "") return refuse(`A row of ${t.name} has no id.`);
        if (fresh.has(old)) return refuse(`The id ${old} is used twice in this file.`);
        fresh.set(old, crypto.randomUUID());
      }
    }

    const order = parentsFirst(restorable);
    const inserts: D1PreparedStatement[] = [];
    const counts: Record<string, number> = {};
    const locked: RestoredLock[] = [];
    for (const t of order) {
      const own = t.refs.filter((r) => r.table === t.name);
      const rows: Record<string, unknown>[] = [];
      for (const row of file.tables[t.name] ?? []) {
        const next: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(row)) {
          if (CUT_COLUMNS[t.name]?.includes(column)) continue;
          // Whose a row is, is the restoring account's to say and never the file's: an old export may carry the column, and a made-up one must not move rows into another account.
          if (column === "owner") continue;
          if (!t.columns.includes(column)) return refuse(`A row of ${t.name} has a column, ${column}, that this copy does not have.`);
          if (value !== null && typeof value !== "string" && typeof value !== "number") {
            return refuse(`A row of ${t.name} holds something other than text or a number in ${column}.`);
          }
          const names = column === "id" || column.endsWith("_id");
          next[column] = names && typeof value === "string" && fresh.has(value) ? fresh.get(value) : value;
        }
        for (const ref of t.refs) {
          const target = byName.get(ref.table);
          const given = row[ref.column];
          if (target === undefined || given === undefined || given === null) continue;
          if (typeof given !== "string" || !fresh.has(given)) return refuse(`A row of ${t.name} points at something this file does not hold.`);
        }
        // A position on the canvas is kept only while the record it sits on is still there.
        if (!t.ownId && typeof row.id === "string" && !fresh.has(row.id)) continue;
        rows.push(next);
      }
      // A row that names another of its own table is placed after it.
      const placed = new Set<unknown>();
      const sorted: Record<string, unknown>[] = [];
      let waiting = rows;
      while (waiting.length > 0) {
        const ready = waiting.filter((r) => own.every((o) => r[o.column] == null || placed.has(r[o.column])));
        if (ready.length === 0) return refuse(`The rows of ${t.name} name each other in a loop.`);
        for (const r of ready) placed.add(r.id);
        sorted.push(...ready);
        waiting = waiting.filter((r) => !ready.includes(r));
      }
      if (sealedOnly && sorted.some((r) => plainRestoredCell(t.name, r))) return { ok: false, status: 409, error: SEALED_ONLY };
      counts[t.name] = sorted.length;
      // A sealed field is bound to its old record id, so it opens only after the device reseals it to the new one.
      const lockable = (Object.keys(LOCKED_COLUMNS) as (keyof typeof LOCKED_COLUMNS)[]).find((k) => LOCKED_COLUMNS[k].table === t.name);
      if (lockable !== undefined) {
        const was = new Map<string, string>();
        for (const [old, now] of fresh) was.set(now, old);
        for (const r of sorted) {
          for (const [column, field] of LOCKED_COLUMNS[lockable].columns) {
            const v = r[column];
            const to = r.id;
            const from = typeof to === "string" ? was.get(to) : undefined;
            if (typeof v === "string" && isSealed(v) && typeof to === "string" && from !== undefined) locked.push({ kind: lockable, field, from, to });
          }
        }
      }
      for (const r of sorted) {
        const columns = Object.keys(r);
        inserts.push(this.db.prepare(
          `INSERT INTO "${t.name}" (owner, ${columns.map((c) => `"${c}"`).join(", ")}) VALUES (?${", ?".repeat(columns.length)})`,
        ).bind(owner, ...columns.map((c) => r[c])));
      }
    }

    // Children before parents, so nothing still names what is being cleared. Rows of the tables the trim
    // cut, while this copy still has them, name ventures and so go first; the file never carries them.
    const cutHere = owned.filter((t) => CUT_TABLES.includes(t.name));
    const clearing = [...cutHere, ...parentsFirst(owned.filter((t) => !kept.has(t.name))).reverse()];
    const statements = clearing.map((t) => this.db.prepare(`DELETE FROM "${t.name}" WHERE owner = ?`).bind(owner));
    statements.push(...inserts);

    // The account's settings follow the file when it has them; the space new tasks go to follows its new id.
    const row = await this.one(`SELECT ${SETTINGS_COLUMNS} FROM account WHERE id = ?`, owner);
    if (row !== null) {
      const named = file.settings?.newTaskVentureId;
      let change: AccountSettingsChange = {
        ...file.settings,
        newTaskVentureId: typeof named === "string" ? (fresh.get(named) ?? null) : null,
      };
      if (sealedOnly) {
        // A level left at its shipped word is stored as nothing, so only a name the person chose has to be an envelope.
        const names = change.levelNames === undefined ? undefined : Object.fromEntries(Object.entries(change.levelNames).map(
          ([level, value]) => [level, value === SHIPPED_NAMES[level as keyof AccountLevelNames] ? null : value],
        )) as NonNullable<AccountSettingsChange["levelNames"]>;
        if (names !== undefined) change = { ...change, levelNames: names };
        const plainName = Object.values(names ?? {}).some((v) => typeof v === "string" && !isEnvelopeShape(v));
        const plainStages = Array.isArray(change.defaultStages) || (typeof change.defaultStages === "string" && !isEnvelopeShape(change.defaultStages));
        if (plainName || plainStages) return { ok: false, status: 409, error: SEALED_ONLY };
      }
      statements.push(this.settingsUpdate(owner, planSettings(row, change)));
    }
    return { ok: true, value: { counts, locked, ids: Object.fromEntries(fresh), statements } };
  }

  async deletion(owner: string): Promise<string | null> {
    return optStr((await this.one(`SELECT delete_on FROM account WHERE id = ?`, owner))?.delete_on);
  }

  async scheduleDeletion(owner: string): Promise<Outcome<{ readonly deleteOn: string }>> {
    const row = await this.one(`SELECT delete_on FROM account WHERE id = ?`, owner);
    if (row === null) return { ok: false, status: 404, error: "this account was not found" };
    const kept = optStr(row.delete_on);
    if (kept !== null) return { ok: true, value: { deleteOn: kept } };
    const deleteOn = new Date(new Date(this.now()).getTime() + DELETION_WAIT_MS).toISOString();
    await this.db.prepare(`UPDATE account SET delete_on = ?, updated_at = ? WHERE id = ?`).bind(deleteOn, this.now(), owner).run();
    return { ok: true, value: { deleteOn } };
  }

  async cancelDeletion(owner: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE account SET delete_on = NULL, updated_at = ? WHERE id = ? AND delete_on IS NOT NULL`,
    ).bind(this.now(), owner).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async purgeAccounts(keep: string): Promise<number> {
    const due = await this.db.prepare(
      `SELECT id FROM account WHERE delete_on IS NOT NULL AND delete_on <= ? AND id <> ?`,
    ).bind(this.now(), keep).all<Row>();
    if (due.results.length === 0) return 0;
    // Children before parents, and every table that names the account before the account itself.
    const tables = parentsFirst(await this.ownedTables()).reverse();
    for (const { id } of due.results) {
      await this.db.batch([
        ...tables.map((t) => this.db.prepare(`DELETE FROM "${t.name}" WHERE owner = ?`).bind(id)),
        this.db.prepare(`DELETE FROM account WHERE id = ?`).bind(id),
        this.db.prepare(`DELETE FROM tenant WHERE id = ?`).bind(id),
      ]);
    }
    return due.results.length;
  }
}
