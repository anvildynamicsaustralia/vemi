/**
 * The calls the About screen makes to update this copy, as plain requests to the Worker's own
 * routes. None goes through the outbox: a queued update tap sent later could start a run nobody
 * is watching. Every refusal carries the Worker's own sentence.
 */

/** The one update on offer, as the Worker reads it from the signed release. Notes are plain text. */
export interface UpdateOffer {
  readonly version: string;
  readonly notes: string;
}

/** What `GET /api/update` says. */
export interface UpdateReport {
  readonly current: string;
  readonly offer: UpdateOffer | null;
  /** The person is the copy's owner and the copy kept the key it updates itself with. */
  readonly canUpdate: boolean;
}

/** The steps a run goes through, in order. `start` takes the restore point. */
export const UPDATE_STEPS = ["start", "files", "data", "app"] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];

/** What one tap answers. `step` is the step that ran; `remaining` is what that step still has to do. */
export interface UpdateTap {
  readonly step: UpdateStep;
  readonly done: boolean;
  readonly remaining: number;
}

/** What the Worker refused, in its own sentence, and the step it stopped at when it says. `status` is 0 when nothing answered. */
export class UpdateCallError extends Error {
  readonly status: number;
  readonly step: UpdateStep | null;
  constructor(status: number, message: string, step: UpdateStep | null = null) {
    super(message);
    this.name = "UpdateCallError";
    this.status = status;
    this.step = step;
  }
}

export interface UpdateApi {
  report(): Promise<UpdateReport>;
  start(): Promise<UpdateTap>;
  step(): Promise<UpdateTap>;
}

const UNREACHABLE = "Couldn't reach VEMI. Check your connection and try again.";
const UNREADABLE = "VEMI gave an answer this version can't read.";

const isStep = (v: unknown): v is UpdateStep => (UPDATE_STEPS as readonly unknown[]).includes(v);

type Doer = typeof fetch;
const realFetch: Doer = (...a) => fetch(...a);

async function callOn(doFetch: Doer, method: "GET" | "POST", path: string, body: unknown = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await doFetch(path, {
      method,
      headers: method === "GET" ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new UpdateCallError(0, UNREACHABLE);
  }
  const parsed: unknown = await response.json().catch(() => ({}));
  const json = (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  if (response.status < 200 || response.status > 299) {
    const said = json["error"];
    throw new UpdateCallError(
      response.status,
      typeof said === "string" && said !== "" ? said : "VEMI could not do that. Try again.",
      isStep(json["step"]) ? json["step"] : null,
    );
  }
  return json;
}

/** What About shows for going back and for the key. Only the owner is told any of it. */
export interface UpdateSettings {
  /** The release Go back returns to and until when, with the restore point when the update changed the data. */
  readonly goBack: { readonly version: string; readonly until: string; readonly restorePoint: string | null } | null;
  /** The release the copy went back to, once it has. */
  readonly backed: string | null;
  /** The copy holds a sealed key, so Update myself is On. */
  readonly keyKept: boolean;
}

export interface UpdateSettingsApi {
  read(): Promise<UpdateSettings>;
  /** Deploys the earlier release. Answers its version. */
  goBack(): Promise<string>;
  /** Deletes the copy's key. Answers the Worker's sentence about what is left to do. */
  turnOff(): Promise<string>;
}

export function updateSettingsApi(doFetch: Doer = realFetch): UpdateSettingsApi {
  return {
    async read() {
      const json = await callOn(doFetch, "GET", "/api/update");
      const back = json["goBack"];
      let goBack: UpdateSettings["goBack"] = null;
      if (typeof back === "object" && back !== null) {
        const b = back as Record<string, unknown>;
        if (typeof b["version"] === "string" && typeof b["until"] === "string") {
          goBack = { version: b["version"], until: b["until"], restorePoint: typeof b["restorePoint"] === "string" ? b["restorePoint"] : null };
        }
      }
      return { goBack, backed: typeof json["backed"] === "string" ? json["backed"] : null, keyKept: json["keyKept"] === true };
    },
    async goBack() {
      const json = await callOn(doFetch, "POST", "/api/update/back");
      return typeof json["version"] === "string" ? json["version"] : "";
    },
    async turnOff() {
      const json = await callOn(doFetch, "POST", "/api/update/off", { confirm: "off" });
      return typeof json["said"] === "string" ? json["said"] : "";
    },
  };
}

export function updateApi(doFetch: Doer = realFetch): UpdateApi {
  const call = (method: "GET" | "POST", path: string): Promise<Record<string, unknown>> => callOn(doFetch, method, path);

  const tap = (json: Record<string, unknown>): UpdateTap => {
    const remaining = json["remaining"];
    if (!isStep(json["step"]) || typeof json["done"] !== "boolean" || typeof remaining !== "number") throw new UpdateCallError(0, UNREADABLE);
    return { step: json["step"], done: json["done"], remaining };
  };

  return {
    async report() {
      const json = await call("GET", "/api/update");
      const offer = json["offer"];
      let found: UpdateOffer | null = null;
      if (typeof offer === "object" && offer !== null) {
        const o = offer as Record<string, unknown>;
        if (typeof o["version"] === "string") found = { version: o["version"], notes: typeof o["notes"] === "string" ? o["notes"] : "" };
      }
      return { current: typeof json["current"] === "string" ? json["current"] : "", offer: found, canUpdate: json["canUpdate"] === true };
    },
    async start() { return tap(await call("POST", "/api/update/start")); },
    async step() { return tap(await call("POST", "/api/update/step")); },
  };
}
