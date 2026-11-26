/**
 * The calls that turn full encryption on and off, as plain requests. None is queued: a batch
 * sent later from an old outbox could write over newer text. The device does the sealing; these
 * only carry what it made to the Worker and read back the Worker's own count of what is left.
 */
import type { EncryptionState } from "./sealedApi.js";

/** Where the account is, and the Worker's count of typed cells still to move. */
export interface EncryptionReport {
  readonly state: EncryptionState;
  /** Cells still holding plain text. */
  readonly unsealed: number;
  /** Cells holding an envelope. */
  readonly sealed: number;
}

/** One record's typed cells. A task's `checklist` is the whole list of `{ text, done }`. */
export interface SealedRecord {
  readonly kind: string;
  readonly id: string;
  readonly fields: Readonly<Record<string, string | readonly { readonly text: string; readonly done: boolean }[]>>;
}

/** What the Worker refused, in its own sentence. `status` is 0 when nothing answered. */
export class EncryptionCallError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "EncryptionCallError";
  }
}

export interface EncryptionApi {
  report(): Promise<EncryptionReport>;
  start(to: "on" | "off"): Promise<EncryptionReport>;
  batch(records: readonly SealedRecord[]): Promise<void>;
  /** Flips the switch when the Worker's own count is zero; otherwise says what is left. */
  finish(): Promise<{ readonly done: boolean; readonly report: EncryptionReport }>;
  /** The export as the Worker makes it: every table, archived rows included. */
  exportAll(): Promise<Record<string, unknown>>;
  /** This account's id, for the settings record. */
  accountId(): Promise<string>;
}

const UNREACHABLE = "Couldn't reach VEMI. Check your connection and try again.";
const STATES: readonly unknown[] = ["off", "turning_on", "on", "turning_off"];

function reportFrom(body: unknown): EncryptionReport {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!STATES.includes(b["state"])) throw new EncryptionCallError(0, "VEMI gave an answer this version can't read.");
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { state: b["state"] as EncryptionState, unsealed: n(b["unsealed"]), sealed: n(b["sealed"]) };
}

const good = (status: number): boolean => status >= 200 && status <= 299;

export function encryptionApi(doFetch: typeof fetch = (...a) => fetch(...a)): EncryptionApi {
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await doFetch(path, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new EncryptionCallError(0, UNREACHABLE);
    }
    const parsed: unknown = await response.json().catch(() => ({}));
    const json = (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    return { status: response.status, json };
  }
  const refused = (r: { status: number; json: Record<string, unknown> }): EncryptionCallError =>
    new EncryptionCallError(r.status, typeof r.json["error"] === "string" ? r.json["error"] : "VEMI could not do that. Try again.");

  return {
    async report() {
      const r = await call("GET", "/api/encryption");
      if (!good(r.status)) throw refused(r);
      return reportFrom(r.json);
    },
    async start(to) {
      const r = await call("POST", "/api/encryption/start", { to });
      if (!good(r.status)) throw refused(r);
      return reportFrom(r.json);
    },
    async batch(records) {
      const r = await call("POST", "/api/encryption/batch", { records });
      if (!good(r.status)) throw refused(r);
    },
    async finish() {
      const r = await call("POST", "/api/encryption/finish", {});
      if (good(r.status)) return { done: true, report: reportFrom(r.json) };
      if (r.status === 409 && STATES.includes(r.json["state"])) return { done: false, report: reportFrom(r.json) };
      throw refused(r);
    },
    async exportAll() {
      const r = await call("GET", "/api/export");
      if (!good(r.status)) throw refused(r);
      return r.json;
    },
    async accountId() {
      const r = await call("GET", "/auth/me");
      const id = r.json["id"];
      if (!good(r.status) || typeof id !== "string" || id === "") {
        throw new EncryptionCallError(r.status, "VEMI could not tell which account this is. Sign in again.");
      }
      return id;
    },
  };
}
