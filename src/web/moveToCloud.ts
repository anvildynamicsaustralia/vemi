/**
 * The move, sent from the browser (move-to-cloud, Task 5). One plain `fetch` to the new copy's
 * own `/setup/move`: no middleman, no cookie, no referrer. The body holds the copy's
 * code, the email and password the person chose for it, and the export document. None of the
 * three is kept anywhere; they live in the call and in the page's memory.
 */
import { moveAddress } from "../shared/setup/getFlow.js";

/** Where the document comes from: the export file the person picked, or a hand-over that holds one. */
export interface MoveSource {
  read(): Promise<unknown>;
}

/** A source over export text, such as the text of a file. */
export function textSource(text: string): MoveSource {
  return { read: () => Promise.resolve().then(() => JSON.parse(text) as unknown) };
}

/** A source over a file the person picked. */
export function fileSource(file: Blob): MoveSource {
  return { read: async () => JSON.parse(await file.text()) as unknown };
}

export interface MoveInput {
  /** The new copy's address. */
  address: string;
  /** The copy's claim code, worked out by `claimFor`. */
  code: string;
  email: string;
  password: string;
  source: MoveSource;
  /** The file holds locked content, so the new copy has a finishing pass to run once the person is in. */
  finish?: boolean;
  fetch?: typeof fetch;
  /** The wait before the one retry; replaced in tests. */
  wait?: (ms: number) => Promise<void>;
}

export interface MoveDone {
  readonly ok: true;
  readonly counts: Readonly<Record<string, number>>;
  readonly locked: unknown;
  readonly ids: Readonly<Record<string, string>>;
  readonly recoveryCode: string;
  /** The link that opens the new copy, signed in, once. */
  readonly openLink: string;
  /** The export's level names, so the done screen can say counts in the person's words. */
  readonly levelNames: Readonly<Record<string, unknown>>;
}

/** `final` means a second try cannot help: the copy exists and the person goes on from inside it. */
export type MoveResult = MoveDone | { readonly ok: false; readonly reason: string; readonly final?: true };

export const RETRY_GAP_MS = 2500;

const NOT_AN_EXPORT = "That file is not a VEMI export.";
const STARTING = "Your new copy is still starting. Try again in a minute.";
/** The copy has an owner now: the account was made, or the first request landed and its reply was lost. */
export const MADE_SIGN_IN = "Your copy was made. Sign in to it and move from Account > Your data.";
const WRONG_CODE = "Your new copy did not take the code for this move.";
const HAS_OWNER = "This copy already has an owner, so nothing was copied into it.";
const TOO_BIG = "That file is too big to move in one go.";
const REFUSED = "Your new copy would not take that. Try again.";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function levelNamesOf(document: Record<string, unknown>): Record<string, unknown> {
  const names = record(record(document["settings"])?.["levelNames"]);
  return names ?? {};
}

/** A calm sentence for what the new copy answered. The copy's own sentence when it sent a short one. */
function refusal(status: number, body: unknown): string {
  if (status === 403) return WRONG_CODE;
  if (status === 409) return HAS_OWNER;
  if (status === 413) return TOO_BIG;
  const said = record(body)?.["error"];
  if (status >= 500 && status !== 500) return STARTING;
  if (status === 404) return STARTING;
  return typeof said === "string" && said !== "" && said.length <= 200 ? said : REFUSED;
}

export async function moveToCloud(input: MoveInput): Promise<MoveResult> {
  const doFetch = input.fetch ?? ((url: RequestInfo | URL, init?: RequestInit) => fetch(url, init));
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let document: Record<string, unknown> | null;
  try {
    document = record(await input.source.read());
  } catch {
    document = null;
  }
  if (document === null || document["format"] !== "vemi-export") return { ok: false, reason: NOT_AN_EXPORT };

  // One body, built once: a retry sends the same bytes.
  const body = JSON.stringify({ code: input.code, email: input.email, password: input.password, document });
  const send = (): Promise<Response> =>
    doFetch(moveAddress(input.address), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });

  let response: Response;
  try {
    response = await send();
  } catch {
    await wait(RETRY_GAP_MS);
    try {
      response = await send();
    } catch {
      return { ok: false, reason: STARTING };
    }
  }

  let answer: unknown = null;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  if (!response.ok) return { ok: false, reason: refusal(response.status, answer) };

  const done = record(answer);
  if (done?.["moved"] === false) return { ok: false, reason: MADE_SIGN_IN, final: true };
  const counts = record(done?.["counts"]);
  const handOver = done?.["handOver"];
  const recoveryCode = done?.["recoveryCode"];
  if (counts === null || typeof handOver !== "string" || typeof recoveryCode !== "string") return { ok: false, reason: STARTING };
  return {
    ok: true,
    counts: counts as Record<string, number>,
    locked: done?.["locked"] ?? [],
    ids: (record(done?.["ids"]) ?? {}) as Record<string, string>,
    recoveryCode,
    openLink: `${input.address.replace(/\/+$/, "")}/auth/move-in?t=${encodeURIComponent(handOver)}${input.finish === true ? "&finish=1" : ""}`,
    levelNames: levelNamesOf(document),
  };
}
