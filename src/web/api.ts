/**
 * The client's one door to the Worker.
 *
 * Reads go straight to `fetch`, so a failure is a failure and the resource that asked keeps
 * what it last had. Writes go through the outbox, so a write made with no connection waits
 * on this device and says so rather than vanishing.
 */
import { fetchOrEarly } from "./earlyAnswers.js";
import type { Appearance, ArchivedItem, CanvasPosition, ExtraSwitch, Kind, Records, Removal, SearchHit, StartScreen } from "@vemi/shared";
import type { GrantItem } from "./connectorLinks.js";
import { isQueued, type Queued } from "./outcome.js";
import { LOCKED_WORD, NeedsKey, encryptionState, openAnswer, sealOutgoing } from "./sealedApi.js";
import { apiFetch } from "./state/outbox.js";

export { isQueued, type Queued };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** A request that never got an answer says so in words, not as the browser's "Failed to fetch". */
export async function reach(request: Promise<Response>): Promise<Response> {
  try {
    return await request;
  } catch {
    throw new ApiError(0, KEY_OFFLINE);
  }
}

export type Input = Readonly<Record<string, unknown>>;

/** The header the service worker puts on a read it answered from its copy. */
export const RECEIVED_AT = "x-vemi-received-at";

export interface Read<T> {
  readonly data: T;
  /** The body as it came, so an answer can be told apart from the last without walking it. */
  readonly text: string;
  /** When this answer left the Worker. `null` when it came from the network just now. */
  readonly receivedAt: string | null;
}

async function answer<T>(response: Response): Promise<T> {
  return parsed<T>(response, await response.text().catch(() => ""));
}

function parsed<T>(response: Response, text: string): T {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (!response.ok) {
    const said = typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : null;
    throw new ApiError(response.status, typeof said === "string" ? said : response.statusText);
  }
  return body as T;
}

export async function read<T>(path: string): Promise<Read<T>> {
  const response = await fetchOrEarly(path, { headers: { accept: "application/json" } });
  const text = await response.text().catch(() => "");
  // Opened here, so every screen gets plain text; `text` stays the body as it came.
  return { data: await openAnswer(path, parsed<T>(response, text)), text, receivedAt: response.headers.get(RECEIVED_AT) };
}

/**
 * The body a write to `path` sends. With the switch off, the body itself; with it on, the typed
 * text sealed, before the outbox or the network sees it.
 */
async function sealedBody(path: string, body: Input): Promise<Input> {
  try {
    return await sealOutgoing(path, body);
  } catch (e) {
    if (e instanceof NeedsKey) throw new ApiError(423, e.message);
    throw e;
  }
}

async function write<T>(method: "POST" | "PATCH" | "PUT", path: string, body: Input = {}): Promise<T | Queued> {
  const response = await apiFetch(path, {
    method,
    // A save started by leaving a field as the tab closes still arrives.
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await sealedBody(path, body)),
  });
  if (response.status === 202) return { queued: true };
  return openAnswer(path, await answer<T>(response));
}

const one = (kind: Kind, id: string): string => `/api/${kind}/${encodeURIComponent(id)}`;

/**
 * Finishing a repeating task on an encrypted account makes the next task with the finished
 * one's title envelope, which is bound to the finished task's id and which the Worker cannot
 * reseal. The answer was opened under the finished id; this writes the plain title back to the
 * new task so it is sealed to its own id. A write the outbox kept for later has no `spawned`,
 * and a reseal that fails leaves the title reading Locked until the title is next saved.
 */
async function resealSpawned(answered: unknown): Promise<void> {
  if (encryptionState() !== "on" || typeof answered !== "object" || answered === null || !("spawned" in answered)) return;
  const next = (answered as { readonly spawned?: { readonly id?: unknown; readonly title?: unknown } | null }).spawned;
  if (typeof next?.id !== "string" || typeof next.title !== "string" || next.title === LOCKED_WORD) return;
  try {
    await write("PATCH", one("tasks", next.id), { title: next.title });
  } catch {
    // The finish itself went through; the title is saved again the next time it is edited.
  }
}

/**
 * A new space on an encrypted account starts with the shipped state and stage names in plain
 * text, and with the shipped stages, because the Worker cannot read the person's own sealed
 * starting stages. This seals those names, and brings the stages to the person's own list
 * (named and kinded by position, more made when the list is longer). A write the outbox kept
 * for later has no id to work on, and a step that fails leaves that name as it is: it holds
 * only a shipped word, and the next turn on seals it.
 */
async function settleNewSpace(answered: unknown): Promise<void> {
  if (encryptionState() !== "on" || typeof answered !== "object" || answered === null) return;
  const id = (answered as { readonly id?: unknown }).id;
  if (typeof id !== "string") return;
  type Named = { readonly id: string; readonly name: string; readonly kind: string };
  try {
    const own = (await read<{ readonly defaultStages?: unknown }>("/api/appearance")).data.defaultStages;
    const wanted = Array.isArray(own)
      ? (own as readonly { readonly name?: unknown; readonly kind?: unknown }[])
        .filter((s): s is { readonly name: string; readonly kind: string } => typeof s.name === "string" && typeof s.kind === "string")
      : [];
    const at = encodeURIComponent(id);
    const states = (await read<Named[]>(`/api/states?venture=${at}`)).data;
    for (const state of states) await write("PATCH", one("states", state.id), { name: state.name });
    const stages = (await read<Named[]>(`/api/stages?venture=${at}`)).data;
    for (const [n, stage] of stages.entries()) {
      const mine = wanted[n];
      await write("PATCH", one("stages", stage.id), mine === undefined ? { name: stage.name } : { name: mine.name, kind: mine.kind });
    }
    for (const mine of wanted.slice(stages.length)) {
      await write("POST", "/api/stages", withId({ ventureId: id, name: mine.name, kind: mine.kind }));
    }
  } catch {
    // The space is made; a name left plain is a shipped word, and the next turn on seals it.
  }
}

/**
 * This device's time zone, as a query. The Worker works out what today is, and turns it over
 * at this device's midnight rather than the operator's. Empty when the browser will not say,
 * and the Worker then uses its own.
 */
function inZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone !== "" ? `?tz=${encodeURIComponent(zone)}` : "";
  } catch {
    return "";
  }
}
let zone = inZone();

/**
 * Once the account's own zone is known it replaces this device's in every request that names
 * one; a null answer (the account never chose) goes back to the device's.
 */
export function setAccountZone(name: string | null): void {
  zone = name === null || name === "" ? inZone() : `?tz=${encodeURIComponent(name)}`;
}

/** The query the requests carry now. For tests. */
export const zoneQuery = (): string => zone;

export const paths = {
  overview: "/api/overview",
  tree: "/api/tree",
  get today(): string { return `/api/today${zone}`; },
  /** Named for the day it was made, in the account's zone. */
  get export(): string { return `/api/export${zone}`; },
  archived: "/api/archived",
  /** The account's accent, spacing and theme. */
  appearance: "/api/appearance",
  /** Where the account is in first run, and which tips it has seen. */
  firstRun: "/api/first-run",
  /** Where the account has put its boxes on the canvas. */
  canvas: "/api/canvas",
  /** Whether this copy shows its front page to someone signed out. Answered with no session. */
  front: "/api/front",
  search: (q: string): string => `/api/search?q=${encodeURIComponent(q)}`,
  /** The searches this person saved. */
  filters: "/api/filters",
  /** The Overdue and Due this week lists, worked out by the Worker for this device's day. */
  get dateFilters(): string { return `/api/filters/dates${zone}`; },
  deletePreview: (kind: Kind, id: string): string => `${one(kind, id)}/delete`,
  /** Every record of a kind, or the ones a filter names. Tags are read whole: there is
      nothing to filter them by, and the picker needs all of them to offer them. */
  list: (kind: Kind, filter: Readonly<Record<string, string>> = {}): string => {
    const asked = new URLSearchParams(filter as Record<string, string>).toString();
    return asked === "" ? `/api/${kind}` : `/api/${kind}?${asked}`;
  },
} as const;

export type SearchAnswer = { readonly results: readonly SearchHit[] };
/** A search this person saved: a name and the words typed. */
export interface SavedFilter {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly position: number;
}
export type FiltersAnswer = { readonly filters: readonly SavedFilter[] };
export type ArchivedAnswer = { readonly items: readonly ArchivedItem[] };
/**
 * Destroy a record for good. Decision 33.
 *
 * Never through the outbox, and never queued: a delete that waits on this device to find a
 * connection is a delete nobody is watching, and this one cannot be undone. With no
 * connection it fails, says so, and the record is still there.
 */
export async function removeForGood(kind: Kind, id: string, confirm: string): Promise<{ readonly removes: Removal }> {
  const response = await reach(fetch(one(kind, id), {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  }));
  return answer<{ removes: Removal }>(response);
}

/**
 * A create names its own id, so the same create sent twice (an offline write retried after
 * the first copy did land) is one record. The Worker answers a repeat with what it stored.
 */
function withId(input: Input): Input {
  return typeof input["id"] === "string" ? input : { ...input, id: crypto.randomUUID() };
}

/**
 * A create named once, as the person acts, and sent as often as it is asked to be. A
 * failure the Worker may have committed before the connection dropped is offered again by
 * running the same work again (`act`'s Try again); stamped here rather than inside that
 * work, every attempt carries the one id, and a repeat that did land is the one record.
 */
export function createOnce<K extends Kind>(kind: K, input: Input): () => Promise<Records[K] | Queued> {
  const named = withId(input);
  return () => api.create(kind, named);
}

/** Saves a change to the account's look. Through the outbox, so a choice made offline still lands. */
export const saveAppearance = (change: Partial<Appearance>) =>
  write<Appearance>("PATCH", paths.appearance, change);

/** Saves the account's level names; null puts one back to its shipped word. Through the outbox, like every setting. */
export const saveLevelNames = (levelNames: { readonly [level: string]: string | null }) =>
  write<unknown>("PATCH", paths.appearance, { levelNames });

/** Saves the stages a new space starts with, or null for the shipped five. Through the outbox, like every setting. */
export const saveDefaultStages = (defaultStages: readonly { readonly name: string; readonly kind: string }[] | null) =>
  write<unknown>("PATCH", paths.appearance, { defaultStages });

/** Saves the space new tasks go to, or null for the space used last. Through the outbox, like every setting. */
export const saveNewTaskVenture = (newTaskVentureId: string | null) =>
  write<unknown>("PATCH", paths.appearance, { newTaskVentureId });

/** Saves the day the weekly review was last finished, or null to take it back. Through the outbox, like every setting. */
export const saveLastReview = (lastReviewOn: string | null) =>
  write<unknown>("PATCH", paths.appearance, { lastReviewOn });

/** What the account chose for reminders. All off for a new account. */
export interface ReminderChoices {
  readonly morningAt: string | null;
  readonly taskReminders: boolean;
  readonly quietFrom: string | null;
  readonly quietTo: string | null;
}

/**
 * Whether the signed-out front page is on. Plain read, no session. Anything that is not a clear
 * yes (no connection, an error, an odd answer) is false, so the sign-in card shows.
 */
export const askFrontLanding = async (): Promise<boolean> => {
  try {
    const { data } = await read<{ landing?: unknown }>(paths.front);
    return data.landing === true;
  } catch {
    return false;
  }
};

/** Turns the signed-out front page on or off. Only the copy's owner may; anyone else is refused. */
export const saveFrontLanding = (landing: boolean) =>
  write<unknown>("PATCH", paths.front, { landing });

/** Saves the account's time zone, a name like Australia/Sydney, or null for the device's. Through the outbox, like every setting. */
export const saveTimeZone = (timeZone: string | null) =>
  write<unknown>("PATCH", paths.appearance, { timeZone });

/** Saves one or more Extras switches. Through the outbox, like every setting. */
export const saveExtras = (extras: Partial<Record<ExtraSwitch, boolean>>) =>
  write<unknown>("PATCH", paths.appearance, { extras });

/** Saves which screen opens first. Through the outbox, like every setting. */
export const saveStartOn = (startOn: StartScreen) =>
  write<unknown>("PATCH", paths.appearance, { startOn });

/** Saves the first-run step (1 to 7), or null when first run is over. Through the outbox, like every setting. */
export const saveFirstRunStep = (step: number | null) =>
  write<unknown>("PATCH", paths.firstRun, { step });

/** Saves that a tip was shown, by name. Through the outbox, like every setting. */
export const saveTipSeen = (tipSeen: string) =>
  write<unknown>("PATCH", paths.firstRun, { tipSeen });

/** Saves a reminder choice. Through the outbox, like every setting. */
export const saveReminders = (change: Partial<ReminderChoices>) =>
  write<unknown>("PATCH", paths.appearance, change);

/*
 * This device's reminders. Never through the outbox: turning them on is a conversation with
 * the push service and the Worker together, and it has no meaning queued for later.
 */
const sendJson = async <T>(method: "POST" | "PATCH" | "DELETE", path: string, body: Input = {}): Promise<T> =>
  openAnswer(path, await answer<T>(await reach(fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await sealedBody(path, body)),
  }))));

/** One thing a connected app did, as the Worker lists it. The earlier values stay on the server. */
export interface ConnectorChangeItem {
  readonly id: string;
  readonly clientName: string;
  readonly tool: string;
  readonly kind: Kind;
  readonly recordId: string;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

/** What apps did in the last 7 days, newest first. Read fresh each time, never queued. */
export const connectorChanges = async (): Promise<readonly ConnectorChangeItem[]> =>
  (await read<{ readonly changes: readonly ConnectorChangeItem[] }>("/api/connector/changes")).data.changes;

/** Puts one of them back. Rejects with the Worker's plain line when it cannot. */
export const undoConnectorChange = (id: string): Promise<ConnectorChangeItem> =>
  sendJson<ConnectorChangeItem>("POST", `/api/connector/changes/${encodeURIComponent(id)}/undo`);

/** The apps let in. Read fresh each time, never queued. */
export const connectorGrants = async (): Promise<readonly GrantItem[]> =>
  (await read<{ readonly grants: readonly GrantItem[] }>("/api/connector/grants")).data.grants;

/** Turns one app off at once: its access stops working. */
export const revokeConnectorGrant = async (id: string): Promise<void> => {
  await sendJson("POST", `/api/connector/grants/${encodeURIComponent(id)}/revoke`);
};

/** The Worker's public key for push, as the browser subscribes with it. */
export const pushKey = async (): Promise<string> =>
  (await read<{ readonly publicKey: string }>("/api/push/key")).data.publicKey;

/** Gives the Worker this device's subscription, with its label and time zone. */
export const pushSave = async (body: Input): Promise<void> => {
  await sendJson("POST", "/api/push/subscribe", body);
};

/** Takes this device off. A device the Worker never knew is already off. */
export const pushForget = async (endpoint: string): Promise<void> => {
  try {
    await sendJson("DELETE", "/api/push/subscribe", { endpoint });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
};

/** Sends a test to every device the account has turned on. */
export const pushTest = (): Promise<{ readonly devices: number; readonly sent: number }> =>
  sendJson("POST", "/api/push/test");

/*
 * An app asking to be let in. Never through the outbox: the answer is meaningful only now, to the
 * app waiting for it.
 */

/** The name the Worker has for an app and the address it will send the person back to, or null when it knows neither. */
export async function connectorClient(id: string, redirectUri: string): Promise<string | null> {
  try {
    const path = `/api/connector/client?id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    return (await read<{ readonly name: string }>(path)).data.name;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Gives the person's answer and returns the address to send them to. */
export const connectorAnswer = async (body: Input): Promise<string> =>
  (await sendJson<{ readonly redirect: string }>("POST", "/api/connector/consent", body)).redirect;

/** Saves box positions, as many as are named. Through the outbox, so a move made offline still lands. */
export const saveCanvas = (positions: readonly CanvasPosition[]) =>
  write<{ readonly positions: readonly CanvasPosition[] }>("PUT", paths.canvas, { positions });

export const api = {
  create: async <K extends Kind>(kind: K, input: Input) => {
    const answered = await write<Records[K]>("POST", `/api/${kind}`, withId(input));
    if (kind === "ventures") await settleNewSpace(answered);
    return answered;
  },
  /** A task finished with a repeat answers with the next task beside it, as `spawned`. */
  update: async <K extends Kind>(kind: K, id: string, patch: Input) => {
    const answered = await write<Records[K] & { readonly spawned?: Records["tasks"] }>("PATCH", one(kind, id), patch);
    if (kind === "tasks") await resealSpawned(answered);
    return answered;
  },
  /** Write new positions, from `order.ts`. Usually one record. */
  place: <K extends Kind>(kind: K, placements: readonly { readonly id: string; readonly position: number }[]) =>
    Promise.all(placements.map((p) => write<Records[K]>("PATCH", one(kind, p.id), { position: p.position }))),
  archive: <K extends Kind>(kind: K, id: string) => write<Records[K]>("POST", `${one(kind, id)}/archive`),
  unarchive: <K extends Kind>(kind: K, id: string) => write<Records[K]>("POST", `${one(kind, id)}/unarchive`),
};

/*
 * Saved filters. Never through the outbox: a name saved for later on a device with no
 * connection is a name the person cannot find on the next one, so these say so when they fail.
 */
export const saveFilter = (name: string, query: string, id?: string): Promise<SavedFilter> =>
  sendJson<SavedFilter>("POST", paths.filters, id === undefined ? { name, query } : { id, name, query });
export const renameSavedFilter = (id: string, name: string): Promise<SavedFilter> =>
  sendJson<SavedFilter>("PATCH", `${paths.filters}/${encodeURIComponent(id)}`, { name });
export const removeSavedFilter = async (id: string): Promise<void> => {
  await sendJson("DELETE", `${paths.filters}/${encodeURIComponent(id)}`);
};

/*
 * Your data. Never through the outbox: a restore replaces everything and a deletion is
 * scheduled for a day, so neither means anything queued for later.
 */
export interface RestoreCounts {
  readonly restored: boolean;
  readonly counts: Readonly<Record<string, number>>;
  /** A preview counts the sealed fields the file holds; a restore lists each, to be resealed here. */
  readonly locked: number | readonly RestoredLock[];
  /** A restore answers each old row id with its new one; an envelope is bound to its row's id. */
  readonly ids?: Readonly<Record<string, string>>;
}
/** A sealed field a restore brought back under a new id, still bound to `from`. */
export interface RestoredLock {
  readonly kind: "projects" | "tasks" | "notes";
  readonly field: string;
  readonly from: string;
  readonly to: string;
}
/** What a file holds, counted by the Worker. Nothing is changed. */
export const previewRestore = (document: Readonly<Record<string, unknown>>): Promise<RestoreCounts> =>
  sendJson<RestoreCounts>("POST", "/api/restore", { document });
/** Replaces this account's data with the file's. */
export const restoreFrom = (document: Readonly<Record<string, unknown>>): Promise<RestoreCounts> =>
  sendJson<RestoreCounts>("POST", "/api/restore", { document, confirm: "replace" });
/** A code, good for 15 minutes and one use, that puts a file's stuff in this account. A new one retires the old. */
export const makeMoveCode = (): Promise<{ readonly code: string; readonly expiresAt: string }> =>
  sendJson("POST", "/api/move-code", {});
/** Schedules this account to go in 7 days; answers the day. */
export const scheduleDeletion = async (): Promise<string> =>
  (await sendJson<{ readonly deleteOn: string }>("POST", "/api/deletion")).deleteOn;
export const cancelDeletion = async (): Promise<void> => {
  await sendJson("POST", "/api/deletion/cancel");
};

/** One sealed field of one live record, as the Worker holds it: `value` is the envelope. */
export interface LockedField {
  readonly kind: "projects" | "tasks" | "notes";
  readonly id: string;
  readonly field: string;
  readonly value: string;
  readonly ventureId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
}
/** Every sealed field, for search on this device. A plain request: the answer is never kept. */
export const lockedFields = (): Promise<readonly LockedField[]> => keyCall<readonly LockedField[]>("GET", "/api/locked");

/*
 * The key's calls. Never through the outbox (C17): setting up, opening, pairing and removing
 * need the Worker's answer now, and queued for later they could leave this device thinking a
 * key was set up when the Worker holds nothing. Offline, each says so and changes nothing.
 * What goes in these bodies is wrapped or public: never an unwrapped key or a password.
 */
export const KEY_OFFLINE = "Couldn't reach VEMI.";

/** One row of a key's wrapped copies or devices, as the Worker lists it. */
export interface KeyRow {
  readonly id: string;
  readonly kind: "passkey" | "password" | "recovery" | "device";
  readonly label: string;
  readonly deviceId: string | null;
  readonly credentialId: string | null;
  readonly salt: string | null;
  readonly iterations: number | null;
  readonly wrapped: string | null;
  readonly createdAt: string;
}

/** A row as a device sends it. */
export type KeyRowInput = Omit<KeyRow, "createdAt">;

export interface KeyState {
  readonly keyRef: string | null;
  readonly keyCheck: string | null;
  readonly wraps: readonly KeyRow[];
}

export interface KeyBundleInput {
  readonly keyRef: string;
  readonly keyCheck: string;
  readonly wraps: readonly KeyRowInput[];
}

export type PairingAnswer = { readonly waiting: true } | { readonly sealed: string };

async function keyCall<T>(method: "GET" | "POST" | "PUT", path: string, body?: object): Promise<T> {
  let response: Response;
  try {
    response = body === undefined
      ? await fetch(path, { headers: { accept: "application/json" } })
      : await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, KEY_OFFLINE);
  }
  return answer<T>(response);
}

const part = encodeURIComponent;

/** The calls the key's orchestration uses, as one object so tests can stand in for the Worker. */
export interface KeyApi {
  keysNow(): Promise<KeyState>;
  addKeys(bundle: KeyBundleInput): Promise<KeyState>;
  archiveKey(id: string): Promise<KeyState>;
  replaceRecovery(wrap: KeyRowInput): Promise<KeyState>;
  startAgain(bundle: KeyBundleInput): Promise<KeyState>;
  openPairing(id: string): Promise<{ readonly id: string; readonly expiresAt: string }>;
  fillPairing(id: string, parts: { readonly sealed: string }): Promise<{ readonly filled: true }>;
  readPairing(id: string): Promise<PairingAnswer>;
}

export const keyApi: KeyApi = {
  keysNow: () => keyCall<KeyState>("GET", "/api/keys"),
  addKeys: (bundle) => keyCall<KeyState>("POST", "/api/keys", bundle),
  archiveKey: (id) => keyCall<KeyState>("POST", `/api/keys/${part(id)}/archive`, {}),
  replaceRecovery: (wrap) => keyCall<KeyState>("POST", "/api/keys/recovery", { wrap }),
  startAgain: (bundle) => keyCall<KeyState>("POST", "/api/keys/start-again", bundle),
  openPairing: (id) => keyCall("POST", "/api/key-pairing", { id }),
  fillPairing: (id, parts) => keyCall("PUT", `/api/key-pairing/${part(id)}`, parts),
  readPairing: (id) => keyCall<PairingAnswer>("GET", `/api/key-pairing/${part(id)}`),
};

export const keysNow = keyApi.keysNow;
export const addKeys = keyApi.addKeys;
export const archiveKey = keyApi.archiveKey;
export const replaceRecovery = keyApi.replaceRecovery;
export const startAgain = keyApi.startAgain;
export const openPairing = keyApi.openPairing;
export const fillPairing = keyApi.fillPairing;
export const readPairing = keyApi.readPairing;
