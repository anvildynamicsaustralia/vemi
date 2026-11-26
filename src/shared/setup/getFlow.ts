/**
 * The setup page's rules, pure: which step comes next, where a closed tab picks up again, and
 * whether a key or a name is fit to go on with. The page (src/web/get) draws them and runs the
 * calls; nothing here touches a network, a storage or a clock.
 *
 * What is kept for a reopened tab is the step, the name and the address, and nothing else. The
 * key lives in memory, and the claim code is worked out again from the account and the name when
 * it is needed, so neither is ever written down (ruling R7).
 */
import { STEP_NAMES, copyNameProblem, newClaimCode, type StepName } from "./buildSteps.js";
import { PASSWORD_MAX, PASSWORD_MIN, passwordLength } from "../limits.js";
import { TOKEN_NAME, TOKEN_PAGE } from "./tokenLink.js";

/** `move` sits between the build and the update step, and is passed over when there is nothing to move. */
export const FLOW_STEPS = ["account", "permission", "name", "build", "move", "update", "done"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/** The five numbered steps, drawn as dots; Done is not one of them, and the move shares the build's dot. */
export const NUMBERED_STEPS: readonly FlowStep[] = ["account", "permission", "name", "build", "update"];

/** The dot a step lights: the move is the build list's last row, so it keeps the build's dot. */
export const dotStep = (step: FlowStep): FlowStep => (step === "move" ? "build" : step);

/** A closed tab picks up again for an hour. */
export const SAVED_FOR_MS = 60 * 60 * 1000;

export const DEFAULT_NAME = "vemi";

/** The page's own fallback: the button for people who would rather make the copy on Cloudflare itself. */
export const DEPLOY_LINK = "https://deploy.workers.cloudflare.com/?url=https://github.com/anvildynamicsaustralia/vemi";

/** Cloudflare's own sign-up page. */
export const SIGN_UP_LINK = "https://dash.cloudflare.com/sign-up";

/** The person's list of keys on Cloudflare, where the key named "VEMI setup" can be taken away by hand. */
export const KEY_LIST_LINK = `${TOKEN_PAGE}?to=/:account/api-tokens`;

export { TOKEN_NAME };

export const isFlowStep = (value: unknown): value is FlowStep => typeof value === "string" && (FLOW_STEPS as readonly string[]).includes(value);

/** The steps that cannot be shown without the key, which a closed tab no longer has. */
export function needsKey(step: FlowStep): boolean {
  return step === "name" || step === "build" || step === "move" || step === "update";
}

/** The step after this one; `withMove` is whether there is a data source to copy from. */
export function stepAfter(step: FlowStep, withMove = false): FlowStep {
  const next = FLOW_STEPS[Math.min(FLOW_STEPS.indexOf(step) + 1, FLOW_STEPS.length - 1)] ?? "done";
  return next === "move" && !withMove ? "update" : next;
}

export function stepBefore(step: FlowStep, withMove = false): FlowStep {
  const before = FLOW_STEPS[Math.max(FLOW_STEPS.indexOf(step) - 1, 0)] ?? "account";
  return before === "move" && !withMove ? "build" : before;
}

// ----- what is kept for a reopened tab -----

/** All that survives a closed tab. No key, no claim code. */
export interface Saved {
  step: FlowStep;
  name: string;
  address: string | null;
}

interface Stored extends Saved {
  v: 1;
  at: number;
}

/** The text kept in session storage. */
export function saveText(saved: Saved, now: number): string {
  const stored: Stored = { v: 1, step: saved.step, name: saved.name, address: saved.address, at: now };
  return JSON.stringify(stored);
}

/** What a kept text holds, or null when it is missing, an hour old, or not ours. */
export function restore(text: string | null, now: number): Saved | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Record<string, unknown>;
  if (stored["v"] !== 1 || !isFlowStep(stored["step"]) || typeof stored["name"] !== "string" || typeof stored["at"] !== "number") return null;
  if (stored["name"].length > 64) return null;
  const age = now - stored["at"];
  if (!(age >= 0 && age < SAVED_FOR_MS)) return null;
  const address = stored["address"];
  if (address !== null && (typeof address !== "string" || !/^https:\/\/[a-z0-9.-]+$/.test(address))) return null;
  // Done is only true with an address to open; the steps after the build only mean something with one.
  if ((stored["step"] === "done" || stored["step"] === "update" || stored["step"] === "move") && address === null) return null;
  return { step: stored["step"], name: stored["name"], address };
}

/** The step to show when the page opens: the saved one, or the key's step when the key is gone. */
export function resumeAt(saved: Saved | null, hasKey: boolean): FlowStep {
  if (saved === null) return "account";
  if (needsKey(saved.step) && !hasKey) return "permission";
  return saved.step;
}

/** Where Next on the permission step goes: back to where the closed tab was, or on to the name. */
export function afterKey(saved: Saved | null): FlowStep {
  return saved !== null && needsKey(saved.step) ? saved.step : "name";
}

// ----- the key -----

/** What can be said about the key from its shape alone: null when it may go to Cloudflare. */
export function keyProblem(text: string): string | null {
  const key = text.trim();
  if (key === "") return null;
  if (key.length < 8 || key.length > 512 || /[\s,]/.test(key)) return "That does not look like a whole key.";
  return null;
}

/** The key as pasted: trimmed, and null when empty or the wrong shape. */
export function keyFrom(text: string): string | null {
  const key = text.trim();
  return key !== "" && keyProblem(key) === null ? key : null;
}

// ----- the name -----

/** A name as typed, made into what a copy is called: lowercase letters, numbers and dashes. */
export function nameFrom(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** A sentence about a name that cannot be used, or null. */
export function nameProblem(text: string): string | null {
  const name = nameFrom(text);
  if (name === "") return "Pick a name for your VEMI.";
  return copyNameProblem(name);
}

// ----- the move's email and password -----

/** A sentence about an email that cannot be used, or null. Only the shape; the copy decides the rest. */
export function emailProblem(text: string): string | null {
  const email = text.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : "Use an email address you can open.";
}

/** The copy's own length rule, said before anything is sent. */
export function passwordProblem(text: string): string | null {
  const length = passwordLength(text);
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

// ----- the build's list -----

/** The move's own row, drawn after the build's six when there is something to copy. */
export const MOVE_ROW = { label: "Copying your stuff", note: "Everything you have here" } as const;

/** Task 3's six steps in plain words. */
export const BUILD_WORDS: Record<StepName, { label: string; note: string }> = {
  Database: { label: "Making your database", note: "Where your tasks and notes will live" },
  "Data layout": { label: "Setting up the layout", note: "The shelves your stuff goes on" },
  "App files": { label: "Getting the app files ready", note: "VEMI itself" },
  App: { label: "Uploading the app", note: "Putting VEMI in your account" },
  "Reminder clock": { label: "Starting the reminder clock", note: "So reminders reach your phone" },
  Address: { label: "Giving it an address", note: "So you can open it anywhere" },
};

export type RowState = "wait" | "run" | "ok" | "bad";

export interface BuildRow {
  step: StepName;
  label: string;
  note: string;
  state: RowState;
}

export interface BuildProgress {
  done: readonly StepName[];
  running: StepName | null;
  failed: StepName | null;
}

/** The six rows, each with its state. */
export function buildRows(progress: BuildProgress): BuildRow[] {
  return STEP_NAMES.map((step) => {
    let state: RowState = "wait";
    if (progress.done.includes(step)) state = "ok";
    else if (progress.failed === step) state = "bad";
    else if (progress.running === step) state = "run";
    return { step, ...BUILD_WORDS[step], state };
  });
}

/** Share of the list that is done, 0 to 100. */
export function buildPercent(progress: BuildProgress): number {
  return Math.round((progress.done.length / STEP_NAMES.length) * 100);
}

export const buildFinished = (progress: BuildProgress): boolean => progress.done.length === STEP_NAMES.length;

// ----- the claim code -----

/**
 * The one-time claim code for this account and this name. Worked out, not made up, so a page that
 * was closed in the middle and reopened, even with a different key for the same account, arrives
 * at the code the copy was built with and can still hand it over. It does not use the key: the
 * App step is skipped on a resume, so a code that followed the key would no longer match the
 * copy's `SETUP_CLAIM`. It is the digest of both and tells nothing about either.
 */
export async function claimFor(accountId: string, name: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`vemi setup claim|${name}|${accountId}`)));
  return newClaimCode((length) => digest.slice(0, length));
}

// ----- the address -----

/** Where the new copy takes the hand-over. */
export function claimAddress(address: string): string {
  return `${address.replace(/\/+$/, "")}/setup/claim`;
}

/** Whether the page was opened by an old account's card: the data is a file the person picks. */
export function fromOldAccount(search: string): boolean {
  return new URLSearchParams(search).get("from") === "old";
}

/** Whether the page was opened by local mode's card: the data is the export the person made on this device, and picks. */
export function fromLocalMode(search: string): boolean {
  return new URLSearchParams(search).get("from") === "local";
}

/** Where the move goes: the new copy's own door, never a relay or the front. */
export function moveAddress(address: string): string {
  return `${address.replace(/\/+$/, "")}/setup/move`;
}
