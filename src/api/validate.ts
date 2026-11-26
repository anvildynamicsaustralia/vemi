/**
 * What a request body may say, per kind. Everything the store receives has passed here.
 *
 * Strict on purpose: an unknown field is refused rather than ignored, because a client
 * that sends `dueDate` and gets a 200 has lost the date without being told.
 *
 * Icons are checked for shape only. Nothing is checked against either icon set, so a name
 * that does not exist is stored and renders as nothing.
 */
import {
  ENCRYPTED_FIELDS, envelopeLimit, EXPORT_VERSIONS, EXTRA_SWITCHES, isAccent, isClock, isEnvelopeShape, isMapStyle, isSealed, isSpacing, isThemeMode, KINDS, LINK_ROLES, NAME_MAX, parseRepeat, PRIORITIES, sealedMax, STAGE_KINDS,
  START_SCREENS, STATE_KINDS, TASK_TITLE_MAX, VENTURE_VIEWS,
  type CanvasPosition, type ChecklistItem, type ExtraSwitches, type Kind, type StageKind, type VentureView,
} from "@vemi/shared";
import { SEAL_BATCH_MOST, type SealRecord } from "./store.js";
import type { AccountSettingsChange, ClientId, FirstRunChange, CreateInput, KeyBundle, KeyKind, KeyWrapInput, NewPushSubscription, NewSavedFilter, PatchInput, RestoreFile } from "./store.js";

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

type Field = (v: unknown, key: string) => Parsed<unknown>;

const fail = (error: string): Parsed<never> => ({ ok: false, error });
const pass = <T>(value: T): Parsed<T> => ({ ok: true, value });

/**
 * Text of up to `max` characters. A whole envelope, which is how a fully encrypted account
 * sends the same text, may run to `envelopeLimit(max)`.
 */
const text = (max: number): Field => (v, key) => {
  if (typeof v !== "string") return fail(`${key} must be text`);
  const t = v.trim();
  if (t === "") return fail(`${key} cannot be empty`);
  if (t.length > max && !(isEnvelopeShape(t) && t.length <= envelopeLimit(max))) return fail(`${key} is longer than ${max} characters`);
  return pass(t);
};

/** Null, or text. Blank text is null, so clearing a field is sending "". */
const optText = (max: number): Field => (v, key) => {
  if (v === null) return pass(null);
  if (typeof v !== "string") return fail(`${key} must be text or null`);
  const t = v.trim();
  if (t === "") return pass(null);
  if (t.length > max && !(isEnvelopeShape(t) && t.length <= envelopeLimit(max))) return fail(`${key} is longer than ${max} characters`);
  return pass(t);
};

/**
 * Like `text`, for a field a person can lock. A whole sealed envelope may run to `sealedMax` of
 * the plain limit; anything else is plain text and keeps the plain limit.
 */
const lockText = (max: number): Field => (v, key) => {
  if (typeof v === "string" && isSealed(v.trim()) && v.trim().length <= sealedMax(max)) return pass(v.trim());
  return text(max)(v, key);
};

/** Like `optText`, for a lockable field. */
const lockOptText = (max: number): Field => (v, key) => {
  if (typeof v === "string" && isSealed(v.trim()) && v.trim().length <= sealedMax(max)) return pass(v.trim());
  return optText(max)(v, key);
};

const id: Field = (v, key) =>
  typeof v === "string" && v.length > 0 && v.length <= 64 ? pass(v) : fail(`${key} must be an id`);

const optId: Field = (v, key) => (v === null ? pass(null) : id(v, key));

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const date: Field = (v, key) => {
  if (v === null) return pass(null);
  const m = typeof v === "string" ? DATE.exec(v) : null;
  if (m === null) return fail(`${key} must be a date, YYYY-MM-DD, or null`);
  const d = new Date(`${v as string}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return fail(`${key} is not a real date`);
  return pass(v);
};

/** Null, or a local wall time `YYYY-MM-DDTHH:MM` that is a real date and a real clock time. */
const remindAt: Field = (v, key) => {
  if (v === null) return pass(null);
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(v) : null;
  const real = m !== null && Number(m[2]) <= 23 && Number(m[3]) <= 59 && date(m[1], key).ok;
  return real ? pass(v) : fail(`${key} must be a local time, YYYY-MM-DDTHH:MM, or null`);
};

/** Null, or a repeat in the grammar of `repeat.ts`. */
const repeat: Field = (v, key) => {
  if (v === null) return pass(null);
  return parseRepeat(v) !== null ? pass(v) : fail(`${key} must be day, weekday, month or week:1 to week:7, or null`);
};

const position: Field =(v, key) =>
  typeof v === "number" && Number.isFinite(v) ? pass(v) : fail(`${key} must be a number`);

/**
 * A number that may be cleared. Board coordinates and today's order are both null until
 * the thing is first moved by hand, and clearing one puts it back in the board's hands.
 */
const optPosition: Field = (v, key) => {
  if (v === null) return pass(null);
  return typeof v === "number" && Number.isFinite(v) ? pass(v) : fail(`${key} must be a number or null`);
};

/** Null, or a moment as an ISO 8601 stamp. */
const optStamp: Field = (v, key) => {
  if (v === null) return pass(null);
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))
    ? pass(v) : fail(`${key} must be a time, or null`);
};

/** Exactly true or false. A flag is never absent-means-false, nor a 0 or 1, nor null. */
const flag: Field = (v, key) => (typeof v === "boolean" ? pass(v) : fail(`${key} must be true or false`));

const oneOf = (values: readonly string[], nullable: boolean): Field => (v, key) => {
  if (nullable && v === null) return pass(null);
  return typeof v === "string" && values.includes(v)
    ? pass(v)
    : fail(`${key} must be one of ${values.join(", ")}${nullable ? ", or null" : ""}`);
};

const checklist: Field = (v, key) => {
  if (!Array.isArray(v)) return fail(`${key} must be a list`);
  if (v.length > 200) return fail(`${key} holds at most 200 items`);
  const items: { text: string; done: boolean }[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return fail(`each ${key} item is { text, done }`);
    const { text: t, done } = item as { text?: unknown; done?: unknown };
    const parsed = text(500)(t, `${key} text`);
    if (!parsed.ok) return parsed;
    if (done !== undefined && typeof done !== "boolean") return fail(`${key} done must be true or false`);
    items.push({ text: parsed.value as string, done: done === true });
  }
  return pass(items);
};

/**
 * The tags on a task or a project, whole: the list sent replaces the list held, and an
 * empty one takes them all off. Ids only. A tag is made by its own create before it can be
 * put on anything, which is what "chosen from what exists" asks for.
 */
const tagIds: Field = (v, key) => {
  if (!Array.isArray(v)) return fail(`${key} must be a list`);
  if (v.length > 50) return fail(`${key} holds at most 50 tags`);
  const out: string[] = [];
  for (const item of v) {
    // "each item in tagIds must be an id": the clause is about one item, so the key is not
    // made its subject ("each tagIds must be").
    const parsed = id(item, `each item in ${key}`);
    if (!parsed.ok) return parsed;
    out.push(parsed.value as string);
  }
  return pass(out);
};

/**
 * A link is a text field, but not one that runs script when it is followed.
 *
 * Without a scheme a browser reads `example.com` as a path inside this app, so a link
 * typed the way people type addresses would open VEMI itself. It is stored as https.
 * `example.com:8080` is a domain and a port, not a scheme called `example.com`.
 */
const url: Field = (v, key) => {
  const parsed = text(2048)(v, key);
  if (!parsed.ok) return parsed;
  const value = parsed.value as string;
  // A sealed link is one envelope: the scheme inside it is checked where it is opened.
  if (isEnvelopeShape(value)) return parsed;
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(value);
  const before = match?.[1]?.toLowerCase() ?? "";
  const port = (before.includes(".") || before === "localhost") && /^\d+(?:[/?#]|$)/.test(match?.[2] ?? "");
  const scheme = match === null || port ? undefined : before;
  if (scheme === "javascript" || scheme === "data" || scheme === "vbscript") return fail(`${key} cannot be a ${scheme}: link`);
  if (scheme === undefined) return pass(`https://${value.replace(/^\/+/, "")}`);
  return parsed;
};

/**
 * An id a client chose for something it is creating. The server's own ids are UUIDs, which
 * this admits, and a client may use any other id of the same plain shape.
 */
const clientId: Field = (v, key) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v)
    ? pass(v)
    : fail(`${key} must be 8 to 64 letters, digits, - or _`);

interface Spec {
  readonly required: Readonly<Record<string, Field>>;
  readonly optional: Readonly<Record<string, Field>>;
  readonly patch: Readonly<Record<string, Field>>;
}

/** The views a space has on: board and projects, each once, and at least one. */
const views: Field = (v, key) => {
  if (!Array.isArray(v)) return fail(`${key} must be a list of ${VENTURE_VIEWS.join(" and ")}`);
  const seen = new Set<unknown>(v);
  if (seen.size !== v.length || v.some((x) => !(VENTURE_VIEWS as readonly unknown[]).includes(x))) {
    return fail(`${key} must name each of ${VENTURE_VIEWS.join(" and ")} at most once`);
  }
  if (v.length === 0) return fail(`${key} must keep at least one view on`);
  return pass(VENTURE_VIEWS.filter((view): view is VentureView => seen.has(view)));
};

const icon = optText(100);

const SPECS: Readonly<Record<Kind, Spec>> = {
  ventures: {
    required: { name: text(NAME_MAX) },
    optional: {
      icon, description: lockOptText(500), parentId: optId, position,
    },
    patch: {
      name: text(NAME_MAX), icon, description: lockOptText(500), parentId: optId, position,
     
      stageId: optId, atRisk: flag, views, monogram: optText(3),
    },
  },
  states: {
    required: { ventureId: id, name: text(60), kind: oneOf(STATE_KINDS, false) },
    optional: { position },
    patch: { name: text(60), kind: oneOf(STATE_KINDS, false), position },
  },
  stages: {
    required: { ventureId: id, name: text(60), kind: oneOf(STAGE_KINDS, false) },
    optional: { position },
    patch: { name: text(60), kind: oneOf(STAGE_KINDS, false), position },
  },
  projects: {
    required: { ventureId: id, name: text(NAME_MAX) },
    optional: { icon, description: lockOptText(500), whoFor: lockOptText(2000), doneLooks: lockOptText(2000), openQuestions: lockOptText(2000),
      position, tagIds, parentId: optId },
    patch: { ventureId: id, name: text(NAME_MAX), icon, description: lockOptText(500), position, tagIds,
      stageId: optId, atRisk: flag, parentId: optId, pinnedAt: optStamp,
      whoFor: lockOptText(2000), doneLooks: lockOptText(2000), openQuestions: lockOptText(2000),
    },
  },
  milestones: {
    required: { projectId: id, name: text(NAME_MAX) },
    optional: { stateId: optId, aimingOn: date, position },
    patch: { name: text(NAME_MAX), stateId: optId, aimingOn: date, position },
  },
  tasks: {
    required: { ventureId: id, title: text(TASK_TITLE_MAX) },
    optional: {
      projectId: optId, milestoneId: optId, stateId: optId, body: lockOptText(20_000), checklist,
      priority: oneOf(PRIORITIES, true), dueOn: date, pickedOn: date, position,
      todayPosition: optPosition, tagIds, remindAt, repeat,
    },
    patch: {
      ventureId: id, title: text(TASK_TITLE_MAX), projectId: optId, milestoneId: optId, stateId: optId, body: lockOptText(20_000),
      checklist, priority: oneOf(PRIORITIES, true), dueOn: date, pickedOn: date, position,
      todayPosition: optPosition, tagIds, remindAt, repeat,
    },
  },
  blockers: {
    required: { taskId: id, reason: text(500) },
    optional: { waitsOnTaskId: optId, person: optText(120), sinceOn: date },
    patch: { reason: text(500), waitsOnTaskId: optId, person: optText(120), sinceOn: date },
  },
  notes: {
    required: { body: lockText(4000) },
    optional: { ventureId: optId, projectId: optId },
    patch: { body: lockText(4000) },
  },
  // A title, a body, one soft date and a place in a list. The parent is chosen once, at
  // creation, and a patch cannot move the record to another.
  decisions: {
    required: { title: text(300) },
    optional: { ventureId: optId, projectId: optId, body: optText(20000), decidedOn: date, position },
    patch: { title: text(300), body: optText(20000), decidedOn: date, position },
  },
  risks: {
    required: { title: text(300) },
    optional: { ventureId: optId, projectId: optId, body: optText(20000), raisedOn: date, position },
    patch: { title: text(300), body: optText(20000), raisedOn: date, position },
  },
  links: {
    required: { url },
    optional: {
      ventureId: optId, projectId: optId, taskId: optId, label: optText(200), role: oneOf(LINK_ROLES, false),
    },
    patch: { url, label: optText(200), role: oneOf(LINK_ROLES, false) },
  },
  // A name and nothing else, here as everywhere. A colour sent with one is refused rather
  // than stored and ignored: there is no colour on a tag and there is not going to be.
  tags: {
    required: { name: text(60) },
    optional: {},
    patch: { name: text(60) },
  },
};

export function isKind(segment: string): segment is Kind {
  return (KINDS as readonly string[]).includes(segment);
}

function objectBody(body: unknown): Parsed<Record<string, unknown>> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? pass(body as Record<string, unknown>)
    : fail("the body must be a JSON object");
}

/** The front page setting: `{ landing: boolean }` and nothing else. */
export function parseFront(body: unknown): Parsed<{ readonly landing: boolean }> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (key !== "landing") return fail(`the front page cannot change ${key}`);
  if (typeof object.value.landing !== "boolean") return fail("landing must be true or false");
  return pass({ landing: object.value.landing });
}

/** Turning Update myself off: `{ confirm: "off" }`, the word typed, and nothing else. */
export function parseOff(body: unknown): Parsed<true> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (key !== "confirm") return fail(`turning off cannot take ${key}`);
  if (object.value.confirm !== "off") return fail("type off to turn Update myself off");
  return pass(true);
}

/** First-run progress: exactly one of `{ step: 1..7 | null }` or `{ tipSeen: "<name>" }`. */
export function parseFirstRun(body: unknown): Parsed<FirstRunChange> {
  const object = objectBody(body);
  if (!object.ok) return object;
  const keys = Object.keys(object.value);
  if (keys.length !== 1) return fail("send exactly one of step or tipSeen");
  const key = keys[0] as string;
  const v = object.value[key];
  if (key === "step") {
    if (v === null) return pass({ step: null });
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 7) return fail("step must be a whole number from 1 to 7, or null");
    return pass({ step: v });
  }
  if (key === "tipSeen") {
    if (typeof v !== "string" || !/^[a-z-]{1,32}$/.test(v)) return fail("tipSeen must be a tip name of lowercase letters and hyphens, up to 32 long");
    return pass({ tipSeen: v });
  }
  return fail(`first run cannot change ${key}`);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** A wrapped copy is `iv.ciphertext`, both base64url. */
const WRAPPED = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/;
/** A sealed pairing copy is `publicPart.iv.ciphertext`, each base64url. */
const WRAPPED_3 = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KEY_KINDS: readonly KeyKind[] = ["passkey", "password", "recovery", "device"];
const KEY_ROW_FIELDS = ["id", "kind", "label", "deviceId", "credentialId", "salt", "iterations", "wrapped"];
export const KEY_WRAPS_MAX = 10;
export const WRAPPED_MAX = 512;
const ITERATIONS_MAX = 10_000_000;

/** Absent or null is null; otherwise base64url text no longer than `max`. */
function optBase64(v: unknown, key: string, max: number, pattern = BASE64URL): Parsed<string | null> {
  if (v === undefined || v === null) return pass(null);
  if (typeof v !== "string" || v === "" || v.length > max || !pattern.test(v)) return fail(`${key} must be base64url text up to ${max} characters, or null`);
  return pass(v);
}

function requiredBase64(v: unknown, key: string, max: number): Parsed<string> {
  const read = optBase64(v, key, max);
  if (!read.ok) return read;
  return read.value === null ? fail(`${key} is required`) : pass(read.value);
}

const keyId = (v: unknown, key: string): Parsed<string> =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? pass(v) : fail(`${key} must be an id of letters, digits, - and _, up to 64 long`);

/** One row of `key_wrap`: the shape each kind needs, nothing else, and nothing unwrapped. */
function parseKeyRow(value: unknown, where: string): Parsed<KeyWrapInput> {
  const object = objectBody(value);
  if (!object.ok) return fail(`${where} must be an object`);
  const row = object.value;
  for (const key of Object.keys(row)) if (!KEY_ROW_FIELDS.includes(key)) return fail(`${where} cannot hold ${key}`);
  const id = keyId(row.id, `${where}.id`);
  if (!id.ok) return id;
  if (typeof row.kind !== "string" || !KEY_KINDS.includes(row.kind as KeyKind)) return fail(`${where}.kind must be passkey, password, recovery or device`);
  const kind = row.kind as KeyKind;
  if (typeof row.label !== "string" || row.label.trim() === "" || row.label.trim().length > 60) return fail(`${where}.label must be text up to 60 characters`);
  const deviceId = row.deviceId === undefined || row.deviceId === null ? pass(null) : keyId(row.deviceId, `${where}.deviceId`);
  if (!deviceId.ok) return deviceId;
  const credentialId = optBase64(row.credentialId, `${where}.credentialId`, 1400);
  if (!credentialId.ok) return credentialId;
  const salt = optBase64(row.salt, `${where}.salt`, 128);
  if (!salt.ok) return salt;
  const wrapped = row.wrapped === undefined || row.wrapped === null ? pass(null) : optBase64(row.wrapped, `${where}.wrapped`, WRAPPED_MAX, WRAPPED);
  if (!wrapped.ok) return wrapped;
  let iterations: number | null = null;
  if (row.iterations !== undefined && row.iterations !== null) {
    if (typeof row.iterations !== "number" || !Number.isInteger(row.iterations) || row.iterations < 1 || row.iterations > ITERATIONS_MAX) {
      return fail(`${where}.iterations must be a whole number from 1 to ${ITERATIONS_MAX}`);
    }
    iterations = row.iterations;
  }
  if (kind === "device") {
    if (wrapped.value !== null || credentialId.value !== null || salt.value !== null || iterations !== null || deviceId.value !== null) {
      return fail(`${where} is a device row and holds only an id and a label`);
    }
  } else {
    if (wrapped.value === null) return fail(`${where}.wrapped is required`);
    if (kind === "passkey" && (credentialId.value === null || salt.value === null)) return fail(`${where} is a passkey row and needs credentialId and salt`);
    if (kind === "password" && (salt.value === null || iterations === null)) return fail(`${where} is a password row and needs salt and iterations`);
    if (kind !== "passkey" && (credentialId.value !== null || deviceId.value !== null)) return fail(`${where} is a ${kind} row and holds no passkey fields`);
  }
  return pass({
    id: id.value, kind, label: row.label.trim(), deviceId: deviceId.value, credentialId: credentialId.value,
    salt: salt.value, iterations, wrapped: wrapped.value,
  });
}

/** `{ keyRef, keyCheck, wraps }`: one account key and one to ten of its rows. */
export function parseKeyBundle(body: unknown): Parsed<KeyBundle> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (!["keyRef", "keyCheck", "wraps"].includes(key)) return fail(`keys cannot hold ${key}`);
  const keyRef = requiredBase64(object.value.keyRef, "keyRef", 64);
  if (!keyRef.ok) return keyRef;
  const keyCheck = requiredBase64(object.value.keyCheck, "keyCheck", 64);
  if (!keyCheck.ok) return keyCheck;
  const given = object.value.wraps;
  if (!Array.isArray(given) || given.length < 1 || given.length > KEY_WRAPS_MAX) return fail(`wraps must be a list of 1 to ${KEY_WRAPS_MAX} rows`);
  const wraps: KeyWrapInput[] = [];
  for (const [n, one] of given.entries()) {
    const row = parseKeyRow(one, `wraps[${n}]`);
    if (!row.ok) return row;
    wraps.push(row.value);
  }
  if (new Set(wraps.map((w) => w.id)).size !== wraps.length) return fail("wraps cannot use one id twice");
  return pass({ keyRef: keyRef.value, keyCheck: keyCheck.value, wraps });
}

/** `{ wrap }`: one recovery row. */
export function parseRecoveryWrap(body: unknown): Parsed<KeyWrapInput> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (key !== "wrap") return fail(`a new recovery key cannot hold ${key}`);
  const row = parseKeyRow(object.value.wrap, "wrap");
  if (!row.ok) return row;
  return row.value.kind === "recovery" ? row : fail("wrap.kind must be recovery");
}

const pairingId = (v: unknown, key: string): Parsed<string> =>
  typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? pass(v) : fail(`${key} must be 16 to 64 letters, digits, - and _`);

/** `{ id }`: the pairing the new device is opening. */
export function parseOpenPairing(body: unknown): Parsed<string> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (key !== "id") return fail(`a pairing cannot hold ${key}`);
  return pairingId(object.value.id, "id");
}

/** The id in a pairing's path. */
export function parsePairingId(v: string): Parsed<string> {
  return pairingId(v, "the pairing id");
}

/** `{ sealed }`: what the unlocked device leaves for the new one. The new device's public half never comes here. */
export function parseFillPairing(body: unknown): Parsed<{ readonly sealed: string }> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (key !== "sealed") return fail(`a pairing cannot hold ${key}`);
  const sealed = optBase64(object.value.sealed, "sealed", 1024, WRAPPED_3);
  if (!sealed.ok) return sealed;
  if (sealed.value === null) return fail("sealed is required");
  return pass({ sealed: sealed.value });
}

export function parseCreate<K extends Kind>(kind: K, body: unknown): Parsed<CreateInput[K] & ClientId> {
  const object = objectBody(body);
  if (!object.ok) return object;
  const spec = SPECS[kind];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object.value)) {
    if (key !== "id" && !(key in spec.required) && !(key in spec.optional)) return fail(`${kind} has no field ${key}`);
  }
  // Every kind may be created under an id the client chose, so a create sent twice is one create.
  if ("id" in object.value) {
    const parsed = clientId(object.value.id, "id");
    if (!parsed.ok) return parsed;
    out.id = parsed.value;
  }
  for (const [key, field] of Object.entries(spec.required)) {
    if (!(key in object.value)) return fail(`${key} is required`);
    const parsed = field(object.value[key], key);
    if (!parsed.ok) return parsed;
    out[key] = parsed.value;
  }
  for (const [key, field] of Object.entries(spec.optional)) {
    if (!(key in object.value)) continue;
    const parsed = field(object.value[key], key);
    if (!parsed.ok) return parsed;
    out[key] = parsed.value;
  }
  if (kind === "notes") {
    const targets = ["ventureId", "projectId"].filter((k) => out[k] !== undefined && out[k] !== null);
    if (targets.length !== 1) return fail("a note attaches to exactly one of ventureId or projectId");
  }
  if (kind === "links") {
    const targets = ["ventureId", "projectId", "taskId"].filter((k) => out[k] !== undefined && out[k] !== null);
    if (targets.length !== 1) return fail("a link attaches to exactly one of ventureId, projectId or taskId");
  }
  if (kind === "decisions" || kind === "risks") {
    const targets = ["ventureId", "projectId"].filter((k) => out[k] !== undefined && out[k] !== null);
    if (targets.length !== 1) {
      return fail(`a ${kind === "decisions" ? "decision" : "risk"} attaches to exactly one of ventureId or projectId`);
    }
  }
  if (kind === "blockers" && out.waitsOnTaskId !== undefined && out.waitsOnTaskId === out.taskId) {
    return fail("a task cannot wait on itself");
  }
  return pass(out as unknown as CreateInput[K]);
}

export function parsePatch<K extends Kind>(kind: K, body: unknown): Parsed<PatchInput[K]> {
  const object = objectBody(body);
  if (!object.ok) return object;
  const spec = SPECS[kind].patch;
  const keys = Object.keys(object.value);
  if (keys.length === 0) return fail("nothing to change");
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = spec[key];
    if (field === undefined) return fail(`${kind} cannot change ${key}`);
    const parsed = field(object.value[key], key);
    if (!parsed.ok) return parsed;
    out[key] = parsed.value;
  }
  return pass(out as PatchInput[K]);
}

const LEVEL_KEYS = ["space", "project", "milestone", "task"] as const;
const LEVEL_NAME_MAX = 30;
const STAGES_MAX = 20;

/** Any of the four level names; null puts one back to its shipped word. */
function parseLevelNames(v: unknown): Parsed<NonNullable<AccountSettingsChange["levelNames"]>> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("levelNames must be an object of space, project, milestone and task");
  const given = v as Record<string, unknown>;
  const out: { -readonly [K in (typeof LEVEL_KEYS)[number]]?: string | null } = {};
  if (Object.keys(given).length === 0) return fail("levelNames must name at least one level");
  for (const key of Object.keys(given)) {
    if (!(LEVEL_KEYS as readonly string[]).includes(key)) return fail(`levelNames has no ${key}`);
    const name = given[key];
    if (name === null) {
      out[key as (typeof LEVEL_KEYS)[number]] = null;
      continue;
    }
    const checked = text(LEVEL_NAME_MAX)(name, `levelNames ${key}`);
    if (!checked.ok) return checked;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(checked.value as string)) return fail(`levelNames ${key} cannot hold control characters`);
    out[key as (typeof LEVEL_KEYS)[number]] = checked.value as string;
  }
  return pass(out);
}

/** The stages a new space starts with: null for the shipped five, or a list of name and kind in order. */
function parseDefaultStages(v: unknown): Parsed<readonly { readonly name: string; readonly kind: StageKind }[] | string | null> {
  if (v === null) return pass(null);
  // A fully encrypted account keeps the whole list as one envelope.
  if (typeof v === "string") {
    return isEnvelopeShape(v) && v.length <= envelopeLimit(2000) ? pass(v) : fail("defaultStages must be null, a list of stages or a sealed list");
  }
  if (!Array.isArray(v) || v.length === 0 || v.length > STAGES_MAX) return fail(`defaultStages must be null or a list of 1 to ${STAGES_MAX} stages`);
  const out: { name: string; kind: StageKind }[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return fail("each default stage is { name, kind }");
    const entry = item as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (key !== "name" && key !== "kind") return fail(`a default stage has no ${key}`);
    const name = text(60)(entry.name, "a default stage name");
    if (!name.ok) return name;
    const kind = oneOf(STAGE_KINDS, false)(entry.kind, "a default stage kind");
    if (!kind.ok) return kind;
    out.push({ name: name.value as string, kind: kind.value as StageKind });
  }
  return pass(out);
}

/** Any of the Extras, each true or false. */
function parseExtras(v: unknown): Parsed<Partial<ExtraSwitches>> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("extras must be an object of switches");
  const given = v as Record<string, unknown>;
  if (Object.keys(given).length === 0) return fail("extras must name at least one switch");
  const out: { -readonly [K in keyof ExtraSwitches]?: boolean } = {};
  for (const key of Object.keys(given)) {
    if (!(EXTRA_SWITCHES as readonly string[]).includes(key)) return fail(`extras has no ${key}`);
    if (typeof given[key] !== "boolean") return fail(`extras ${key} must be true or false`);
    out[key as keyof ExtraSwitches] = given[key] as boolean;
  }
  return pass(out);
}

/**
 * A change to the account's settings: any of accent, spacing, theme, mapStyle, the space new
 * tasks go to and the day of the last review, and nothing else. Strict like the record kinds:
 * a misspelt name is refused, not dropped. Whether the space is the caller's is the store's
 * to say. The names of the four levels, the starting stages, the first screen, the Extras and
 * the time zone ride the same route.
 */
export function parseAppearance(body: unknown): Parsed<AccountSettingsChange> {
  const object = objectBody(body);
  if (!object.ok) return object;
  const keys = Object.keys(object.value);
  if (keys.length === 0) return fail("nothing to change");
  const out: { -readonly [K in keyof AccountSettingsChange]?: AccountSettingsChange[K] } = {};
  for (const key of keys) {
    const v = object.value[key];
    if (key === "accent") {
      if (!isAccent(v)) return fail("accent must be ember, ocean, moss, violet, rose or graphite");
      out.accent = v;
    } else if (key === "spacing") {
      if (!isSpacing(v)) return fail("spacing must be comfortable or compact");
      out.spacing = v;
    } else if (key === "theme") {
      if (!isThemeMode(v)) return fail("theme must be light, dark or system");
      out.theme = v;
    } else if (key === "mapStyle") {
      if (!isMapStyle(v)) return fail("mapStyle must be grid or canvas");
      out.mapStyle = v;
    } else if (key === "newTaskVentureId") {
      if (v !== null && (typeof v !== "string" || v === "")) return fail("newTaskVentureId must be a space id or null");
      out.newTaskVentureId = v;
    } else if (key === "lastReviewOn") {
      if (v !== null && (typeof v !== "string" || !isDate(v))) return fail("lastReviewOn must be a date as YYYY-MM-DD, or null");
      out.lastReviewOn = v;
    } else if (key === "morningAt") {
      if (v !== null && !isClock(v)) return fail("morningAt must be a time as HH:MM, or null");
      out.morningAt = v;
    } else if (key === "taskReminders") {
      if (typeof v !== "boolean") return fail("taskReminders must be true or false");
      out.taskReminders = v;
    } else if (key === "quietFrom" || key === "quietTo") {
      if (v !== null && !isClock(v)) return fail(`${key} must be a time as HH:MM, or null`);
      out[key] = v;
    } else if (key === "levelNames") {
      const names = parseLevelNames(v);
      if (!names.ok) return names;
      out.levelNames = names.value;
    } else if (key === "defaultStages") {
      const stages = parseDefaultStages(v);
      if (!stages.ok) return stages;
      out.defaultStages = stages.value;
    } else if (key === "startOn") {
      if (!(START_SCREENS as readonly unknown[]).includes(v)) return fail(`startOn must be ${START_SCREENS.join(" or ")}`);
      out.startOn = v as (typeof START_SCREENS)[number];
    } else if (key === "extras") {
      const extras = parseExtras(v);
      if (!extras.ok) return extras;
      out.extras = extras.value;
    } else if (key === "timeZone") {
      if (v !== null && (typeof v !== "string" || v.length > 64 || !knownZone(v))) {
        return fail("timeZone must be a name like Australia/Sydney, or null");
      }
      out.timeZone = v;
    } else {
      return fail(`appearance cannot change ${key}`);
    }
  }
  return pass(out);
}

/**
 * A restore: `{ document, confirm? }`. The document is an export file, version 1 or 2; the
 * settings of a version 2 file are held to the same rules as a change to them. `confirm`
 * is the word "replace" or absent, and `confirmed` says which.
 */
export function parseRestore(body: unknown): Parsed<{ readonly file: RestoreFile; readonly confirmed: boolean }> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) {
    if (key !== "document" && key !== "confirm") return fail(`restore cannot take ${key}`);
  }
  const { confirm } = object.value;
  if (confirm !== undefined && confirm !== "replace") return fail("confirm must be the word replace");
  const document = objectBody(object.value.document);
  if (!document.ok) return fail("document must be an export file");
  const doc = document.value;
  if (doc.format !== "vemi-export") return fail("this is not a VEMI export file");
  if (!(EXPORT_VERSIONS as readonly unknown[]).includes(doc.version)) {
    return fail(`this export is version ${String(doc.version)}; this copy reads ${EXPORT_VERSIONS.join(" and ")}`);
  }
  const tables = objectBody(doc.tables);
  if (!tables.ok) return fail("the file has no tables");
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [name, rows] of Object.entries(tables.value)) {
    if (!Array.isArray(rows)) return fail(`${name} must be a list of rows`);
    const list: Record<string, unknown>[] = [];
    for (const row of rows) {
      const checked = objectBody(row);
      if (!checked.ok) return fail(`a row of ${name} is not an object`);
      list.push(checked.value);
    }
    out[name] = list;
  }
  let settings: AccountSettingsChange | undefined;
  if (doc.version === 2 && doc.settings !== undefined) {
    const given = objectBody(doc.settings);
    if (!given.ok) return fail("settings must be an object");
    // Where a copy was in full encryption is not something a file can set.
    const { encryption: _state, ...chosen } = given.value;
    if (Object.keys(chosen).length > 0) {
      const parsed = parseAppearance(chosen);
      if (!parsed.ok) return fail(`the file's settings: ${parsed.error}`);
      settings = parsed.value;
    }
  }
  return pass({ file: settings === undefined ? { tables: out } : { tables: out, settings }, confirmed: confirm === "replace" });
}

/** Whether this runtime knows the IANA zone name. */
function knownZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The push services a browser subscribes through. The Worker POSTs to the endpoint a device
 * gives, so only these server names (each exactly, or any subdomain of it) are accepted:
 * Chrome and Android (FCM), Firefox, Safari and Apple devices, and Edge and Windows.
 */
export const PUSH_SERVICE_NAMES: readonly string[] = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
  "push.apple.com",
  "notify.windows.com",
];

/** True for an https address with no sign-in part and no port whose server name is on the list. */
export function isKnownPushService(address: URL): boolean {
  if (address.protocol !== "https:" || address.username !== "" || address.password !== "") return false;
  if (address.port !== "") return false;
  const name = address.hostname.toLowerCase().replace(/\.$/, "");
  return PUSH_SERVICE_NAMES.some((known) => name === known || name.endsWith(`.${known}`));
}

const PUSH_LABEL_MAX = 80;

/**
 * A device's subscription, as the browser's `PushSubscription.toJSON()` gives it
 * (`endpoint` and `keys.p256dh`, `keys.auth`), with an optional `label` and the device's
 * `tz`. The zone falls back to `fallbackZone` when the device does not send one.
 */
export function parsePushSubscription(body: unknown, fallbackZone: string): Parsed<NewPushSubscription> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) {
    if (!["endpoint", "keys", "label", "tz", "expirationTime"].includes(key)) return fail(`a subscription has no ${key}`);
  }
  const { endpoint, keys, label, tz } = object.value;
  if (typeof endpoint !== "string" || endpoint.length > 2048) return fail("endpoint must be the subscription's address");
  let address: URL;
  try {
    address = new URL(endpoint);
  } catch {
    return fail("endpoint must be the subscription's address");
  }
  if (address.protocol !== "https:") return fail("endpoint must be an https address");
  if (!isKnownPushService(address)) return fail("endpoint must be a known push service address");
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) return fail("keys must hold p256dh and auth");
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh)) return fail("keys.p256dh must be the device's public key");
  if (typeof auth !== "string" || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return fail("keys.auth must be the device's auth secret");
  if (label !== undefined && label !== null && (typeof label !== "string" || label.length > PUSH_LABEL_MAX)) {
    return fail(`label must be text of ${PUSH_LABEL_MAX} characters or fewer`);
  }
  if (tz !== undefined && tz !== null && (typeof tz !== "string" || tz.length > 64 || !knownZone(tz))) {
    return fail("tz must be a time zone name, such as Australia/Sydney");
  }
  return pass({
    endpoint, p256dh, auth,
    label: typeof label === "string" && label.trim() !== "" ? label.trim() : null,
    tz: typeof tz === "string" ? tz : fallbackZone,
  });
}

const FILTER_NAME_MAX = 60;
const FILTER_QUERY_MAX = 200;

/** A saved filter: a name of 1 to 60 characters and the query it runs, 1 to 200. */
export function parseNewFilter(body: unknown): Parsed<NewSavedFilter> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) {
    if (key !== "name" && key !== "query" && key !== "id") return fail(`a saved filter has no ${key}`);
  }
  if (!("name" in object.value)) return fail("name is required");
  if (!("query" in object.value)) return fail("query is required");
  const name = text(FILTER_NAME_MAX)(object.value.name, "name");
  if (!name.ok) return name;
  const query = text(FILTER_QUERY_MAX)(object.value.query, "query");
  if (!query.ok) return query;
  if (object.value.id === undefined) return pass({ name: name.value as string, query: query.value as string });
  const chosen = clientId(object.value.id, "id");
  if (!chosen.ok) return chosen;
  return pass({ id: chosen.value as string, name: name.value as string, query: query.value as string });
}

/** A rename: the name alone. The query a filter runs does not change. */
export function parseFilterRename(body: unknown): Parsed<string> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) {
    if (key !== "name") return fail(`a rename has no ${key}`);
  }
  if (!("name" in object.value)) return fail("name is required");
  const name = text(FILTER_NAME_MAX)(object.value.name, "name");
  return name.ok ? pass(name.value as string) : name;
}

/** `{ to: "on" | "off" }` and nothing else. */
export function parseEncryptionStart(body: unknown): Parsed<"on" | "off"> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (key !== "to") return fail(`start has no ${key}`);
  const to = object.value.to;
  return to === "on" || to === "off" ? pass(to) : fail("to must be on or off");
}

/** The longest one sealed cell may be: a task body of 20,000 characters, sealed. */
const SEALED_CELL_MAX = envelopeLimit(20_000);

/**
 * One batch of typed cells: `{ records: [{ kind, id, fields }] }`, at most `SEAL_BATCH_MOST`
 * records. A kind is a typed kind, `settings` or `connector_change`; a field is one the kind
 * seals, holding text, except a task's `checklist`, which is the whole list of `{ text, done }`.
 * Whether the text is an envelope is the store's to say, because it depends on which way
 * the account is turning.
 */
export function parseSealBatch(body: unknown): Parsed<readonly SealRecord[]> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (key !== "records") return fail(`a batch has no ${key}`);
  const { records } = object.value;
  if (!Array.isArray(records) || records.length === 0) return fail("records must be a list of at least one record");
  if (records.length > SEAL_BATCH_MOST) return fail(`records holds at most ${SEAL_BATCH_MOST} records`);
  const out: SealRecord[] = [];
  for (const item of records) {
    const one = objectBody(item);
    if (!one.ok) return fail("each record is { kind, id, fields }");
    for (const key of Object.keys(one.value)) if (!["kind", "id", "fields"].includes(key)) return fail(`a record has no ${key}`);
    const kind = one.value.kind;
    const names = typeof kind === "string" && Object.hasOwn(ENCRYPTED_FIELDS, kind)
      ? ((ENCRYPTED_FIELDS as Record<string, readonly string[]>)[kind] as readonly string[])
      : kind === "connector_change" ? ["before"] : null;
    if (typeof kind !== "string" || names === null) return fail("kind must be a typed kind, settings or connector_change");
    const named = id(one.value.id, "id");
    if (!named.ok) return named;
    const fields = objectBody(one.value.fields);
    if (!fields.ok) return fail("fields must be an object");
    const allowed = kind === "tasks" ? [...names, "checklist"] : names;
    const cells: Record<string, string | ChecklistItem[]> = {};
    if (Object.keys(fields.value).length === 0) return fail("fields must name at least one field");
    for (const [field, value] of Object.entries(fields.value)) {
      if (!allowed.includes(field)) return fail(`${kind} has no sealed field ${field}`);
      if (field === "checklist") {
        if (!Array.isArray(value) || value.length > 200) return fail("checklist must be a list of at most 200 items");
        const items: ChecklistItem[] = [];
        for (const step of value) {
          const s = step as { text?: unknown; done?: unknown } | null;
          if (typeof s !== "object" || s === null || typeof s.text !== "string" || s.text === "" || s.text.length > SEALED_CELL_MAX) {
            return fail("each checklist item is { text, done }");
          }
          items.push({ text: s.text, done: s.done === true });
        }
        cells[field] = items;
      } else {
        if (typeof value !== "string" || value === "" || value.length > SEALED_CELL_MAX) return fail(`${field} must be text`);
        cells[field] = value;
      }
    }
    if (out.some((r) => r.kind === kind && r.id === named.value)) return fail("a record is sent twice in one batch");
    out.push({ kind: kind as SealRecord["kind"], id: named.value as string, fields: cells });
  }
  return pass(out);
}

/** The endpoint a device names to turn its reminders off. */
export function parsePushEndpoint(body: unknown): Parsed<string> {
  const object = objectBody(body);
  if (!object.ok) return object;
  const { endpoint } = object.value;
  if (typeof endpoint !== "string" || endpoint === "" || endpoint.length > 2048) return fail("endpoint must be the subscription's address");
  return pass(endpoint);
}

/** Most boxes one PUT may place. Far above any real map; a bound, not a limit anyone meets. */
const CANVAS_MOST = 500;

/**
 * A batch of canvas positions: `{ positions: [{ kind, id, x, y }] }`. Strict like the rest: a
 * kind other than venture or project, a coordinate that is not a finite number, or an extra
 * key is refused, and a box named twice is refused rather than left to the last one.
 */
export function parseCanvas(body: unknown): Parsed<CanvasPosition[]> {
  const object = objectBody(body);
  if (!object.ok) return object;
  for (const key of Object.keys(object.value)) if (key !== "positions") return fail(`canvas cannot change ${key}`);
  const list = object.value.positions;
  if (!Array.isArray(list)) return fail("positions must be a list");
  if (list.length > CANVAS_MOST) return fail(`positions is longer than ${CANVAS_MOST} boxes`);
  const out: CanvasPosition[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const one = objectBody(item);
    if (!one.ok) return fail("each position must be an object");
    for (const key of Object.keys(one.value)) if (!["kind", "id", "x", "y"].includes(key)) return fail(`a position cannot hold ${key}`);
    const { kind, id: boxId, x, y } = one.value;
    if (kind !== "venture" && kind !== "project") return fail("kind must be venture or project");
    const named = id(boxId, "id");
    if (!named.ok) return named;
    if (typeof x !== "number" || !Number.isFinite(x)) return fail("x must be a number");
    if (typeof y !== "number" || !Number.isFinite(y)) return fail("y must be a number");
    const key = `${kind}:${named.value}`;
    if (seen.has(key)) return fail(`${kind} ${named.value} is placed twice`);
    seen.add(key);
    out.push({ kind, id: named.value as string, x, y });
  }
  return pass(out);
}

export function isDate(v: string): boolean {
  return date(v, "date").ok && v !== null;
}

/**
 * Whether a request says its body is JSON: the media type itself, not a mention of it.
 * `text/plain; x=application/json` is a type a page elsewhere may send without asking first,
 * and it is not JSON. The `/api` routes and the auth routes both ask this.
 */
export function sentJson(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

/** A loopback address, where a desktop app listens for the answer and the port is its own pick. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether an address is one an app may be sent back to: HTTPS, or HTTP on loopback; no fragment, no login. */
export function isRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.hash !== "" || u.username !== "" || u.password !== "") return false;
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
}

/** An address with its port taken out when it is loopback, for the one place a port is not compared. */
function withoutLoopbackPort(value: string): string {
  const u = new URL(value);
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) u.port = "";
  return u.href;
}

/** Whether an app that named `registered` may be sent back to `asked`: the same address, or the same loopback address on any port. */
export function redirectAllowed(registered: readonly string[], asked: string): boolean {
  if (!isRedirectUri(asked)) return false;
  const want = withoutLoopbackPort(asked);
  return registered.some((r) => r === asked || (isRedirectUri(r) && withoutLoopbackPort(r) === want));
}

const REDIRECTS_MAX = 5;

/** The name and return addresses an app gives, from a registration body or its published metadata. */
export function parseClientMetadata(body: unknown): Parsed<{ name: string; redirectUris: string[] }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("send { client_name, redirect_uris }");
  const o = body as Record<string, unknown>;
  const uris = o.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > REDIRECTS_MAX) {
    return fail(`redirect_uris must list one to ${REDIRECTS_MAX} addresses`);
  }
  if (!uris.every(isRedirectUri)) return fail("redirect_uris must be https addresses, or http on loopback, with no fragment");
  const named = typeof o.client_name === "string" ? o.client_name.trim() : "";
  const name = (named === "" ? "An app" : named).slice(0, 100);
  return pass({ name, redirectUris: [...new Set(uris as string[])] });
}

export interface ConsentBody {
  readonly decision: "allow" | "deny";
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | null;
  readonly resource: string | null;
}

/** The body of `POST /api/connector/consent`: the person's answer and the request it answers, whole. */
export function parseConsent(body: unknown): Parsed<ConsentBody> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("send { decision, clientId, redirectUri, codeChallenge, state, resource }");
  }
  const o = body as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!["decision", "clientId", "redirectUri", "codeChallenge", "state", "resource"].includes(key)) return fail(`a consent has no ${key}`);
  }
  if (o.decision !== "allow" && o.decision !== "deny") return fail("decision must be allow or deny");
  for (const key of ["clientId", "redirectUri", "codeChallenge"] as const) {
    if (typeof o[key] !== "string" || o[key] === "" || (o[key] as string).length > 2000) return fail(`${key} must be text`);
  }
  for (const key of ["state", "resource"] as const) {
    const v = o[key];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.length > 2000)) return fail(`${key} must be text`);
  }
  return pass({
    decision: o.decision, clientId: o.clientId as string, redirectUri: o.redirectUri as string,
    codeChallenge: o.codeChallenge as string,
    state: typeof o.state === "string" ? o.state : null, resource: typeof o.resource === "string" ? o.resource : null,
  });
}
