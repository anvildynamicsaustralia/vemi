/**
 * A small Cloudflare client over an injected `fetch`, so the browser, the relay and the tests share
 * it. One function per call the build needs. Every refusal is one plain sentence, and the key never
 * appears in an error: a `SetupError` message is built from our own words and Cloudflare's reply
 * with the key cut out. Nothing here reads a global `fetch`.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const CLOUDFLARE_BASE = "https://api.cloudflare.com/client/v4";

/** A refusal with a sentence a person can read. `status` is Cloudflare's, or 0 when it was not reached. */
export class SetupError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "SetupError";
    this.status = status;
  }
}

export interface ClientOptions {
  fetch: FetchLike;
  /** The API key. Held in this closure and sent as a header; never stored or echoed. */
  token: string;
  /** Where the calls go; the relay's address when the browser cannot reach Cloudflare itself. */
  base?: string;
}

export interface Account {
  id: string;
  name: string;
}

export interface Database {
  id: string;
  name: string;
}

export interface AssetFile {
  /** The 32 character key (`assetKey`). */
  hash: string;
  contentType: string;
  /** The file's base64 text. */
  base64: string;
}

export interface WorkerUpload {
  metadata: Record<string, unknown>;
  /** The module file name that `metadata.main_module` names. */
  moduleName: string;
  module: string;
  /** Binding types Cloudflare keeps from the version already running (`keep_bindings`), so an update does not lose a secret it did not name. */
  keepBindings?: string[];
}

/** One deployment: the version serving all traffic. */
export interface Deployment {
  id: string;
  versionId: string;
}

export interface WorkerVersion {
  id: string;
  number: number | null;
}

interface Envelope {
  success?: boolean;
  errors?: { message?: string }[];
  result?: unknown;
}

const MAX_REASON = 160;

export function createCloudflare(options: ClientOptions) {
  const { token } = options;
  const base = options.base ?? CLOUDFLARE_BASE;

  /** Cloudflare's words with the key cut out, on one line, short. */
  function clean(text: string): string {
    let out = token === "" ? text : text.split(token).join("");
    out = out.replace(/\s+/g, " ").trim().replace(/[.:;!?]+$/, "");
    return out.length > MAX_REASON ? `${out.slice(0, MAX_REASON).trimEnd()}...` : out;
  }

  function refusal(what: string, status: number, body: Envelope | null): SetupError {
    let why: string;
    if (status === 401 || status === 403) why = "the key was refused, or it lacks a permission this step needs";
    else if (status === 404) why = "Cloudflare could not find it";
    else if (status === 409) why = "it clashes with something already there";
    else if (status === 429) why = "Cloudflare asked us to slow down, so wait a minute and try again";
    else if (status >= 500) why = "Cloudflare had a problem on its side, so try again in a few minutes";
    else if (status >= 200 && status < 300 && body === null) why = "its answer could not be read, so try again";
    else {
      const said = body?.errors?.find((e) => typeof e.message === "string" && e.message !== "")?.message;
      why = said ? clean(said) : "Cloudflare said no";
    }
    return new SetupError(`Cloudflare would not ${what}: ${why}.`, status);
  }

  async function send(what: string, method: string, path: string, body: unknown, auth: string = token): Promise<Envelope> {
    const headers: Record<string, string> = { authorization: `Bearer ${auth}` };
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, { method, headers, body: payload });
    } catch {
      throw new SetupError(`Cloudflare could not be reached to ${what}.`);
    }
    let parsed: Envelope | null = null;
    try {
      parsed = (await response.json()) as Envelope;
    } catch {
      parsed = null;
    }
    if (!response.ok || parsed === null || parsed.success === false) throw refusal(what, response.status, parsed);
    return parsed;
  }

  /** Like `send`, but a 404 answers null: the thing is not there, which is not a refusal. */
  async function sendOrAbsent(what: string, method: string, path: string): Promise<Envelope | null> {
    try {
      return await send(what, method, path, undefined);
    } catch (error) {
      if (error instanceof SetupError && error.status === 404) return null;
      throw error;
    }
  }

  const acct = (id: string): string => `/accounts/${encodeURIComponent(id)}`;
  const script = (id: string, name: string): string => `${acct(id)}/workers/scripts/${encodeURIComponent(name)}`;

  const calls = {
    /** Is the key live. */
    async verifyToken(): Promise<void> {
      await send("check the key", "GET", "/user/tokens/verify", undefined);
    },

    async listAccounts(): Promise<Account[]> {
      const reply = await send("list the accounts", "GET", "/accounts?per_page=50", undefined);
      const rows = (reply.result ?? []) as { id: string; name: string }[];
      return rows.map((row) => ({ id: row.id, name: row.name }));
    },

    /** The account's workers.dev subdomain, or null when it has none yet. */
    async getSubdomain(accountId: string): Promise<string | null> {
      const reply = await sendOrAbsent("read the address", "GET", `${acct(accountId)}/workers/subdomain`);
      const name = (reply?.result as { subdomain?: string } | null | undefined)?.subdomain;
      return name ? name : null;
    },

    async setSubdomain(accountId: string, subdomain: string): Promise<string> {
      const reply = await send("make the address", "PUT", `${acct(accountId)}/workers/subdomain`, { subdomain });
      return (reply.result as { subdomain: string }).subdomain;
    },

    async findDatabase(accountId: string, name: string): Promise<Database | null> {
      const reply = await send("look for the database", "GET", `${acct(accountId)}/d1/database?name=${encodeURIComponent(name)}`, undefined);
      const rows = (reply.result ?? []) as { uuid: string; name: string }[];
      const row = rows.find((r) => r.name === name);
      return row ? { id: row.uuid, name: row.name } : null;
    },

    async createDatabase(accountId: string, name: string): Promise<Database> {
      const reply = await send("make the database", "POST", `${acct(accountId)}/d1/database`, { name });
      const row = reply.result as { uuid: string; name: string };
      return { id: row.uuid, name: row.name };
    },

    /** Runs SQL (several statements joined by semicolons) and answers the rows of its last statement. */
    async query(accountId: string, databaseId: string, sql: string): Promise<Record<string, unknown>[]> {
      const reply = await send("change the data layout", "POST", `${acct(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, { sql });
      const sets = (reply.result ?? []) as { results?: Record<string, unknown>[] }[];
      return sets[sets.length - 1]?.results ?? [];
    },

    /** Opens an upload session; `buckets` lists the hashes Cloudflare still needs. */
    async startAssets(accountId: string, name: string, manifest: Record<string, { hash: string; size: number }>): Promise<{ jwt: string; buckets: string[][] }> {
      const reply = await send("start the file upload", "POST", `${script(accountId, name)}/assets-upload-session`, { manifest });
      const result = reply.result as { jwt: string; buckets?: string[][] };
      return { jwt: result.jwt, buckets: result.buckets ?? [] };
    },

    /** Uploads one bucket with the session's own jwt; answers the completion jwt after the last. */
    async uploadAssets(accountId: string, sessionJwt: string, files: AssetFile[]): Promise<string | null> {
      const form = new FormData();
      for (const file of files) form.append(file.hash, new Blob([file.base64], { type: file.contentType }), file.hash);
      const reply = await send("upload the app files", "POST", `${acct(accountId)}/workers/assets/upload?base64=true`, form, sessionJwt);
      const jwt = (reply.result as { jwt?: string } | undefined)?.jwt;
      return jwt ? jwt : null;
    },

    /** The tags of a deployed Worker, or null when no Worker has that name. */
    async getWorkerTags(accountId: string, name: string): Promise<string[] | null> {
      const reply = await sendOrAbsent("read the app", "GET", `${script(accountId, name)}/settings`);
      if (reply === null) return null;
      return ((reply.result as { tags?: string[] } | undefined)?.tags ?? []).slice();
    },

    /** The names and types of the bindings the Worker holds now (never a value), or null when no Worker has that name. */
    async getWorkerBindings(accountId: string, name: string): Promise<{ name: string; type: string }[] | null> {
      const reply = await sendOrAbsent("read what the app holds", "GET", `${script(accountId, name)}/settings`);
      if (reply === null) return null;
      const rows = (reply.result as { bindings?: { name?: unknown; type?: unknown }[] } | undefined)?.bindings ?? [];
      return rows.flatMap((row) => (typeof row.name === "string" && typeof row.type === "string" ? [{ name: row.name, type: row.type }] : []));
    },

    /** Puts the app online; answers the new version's ID, or null when Cloudflare did not say. */
    async uploadWorker(accountId: string, name: string, upload: WorkerUpload): Promise<string | null> {
      const metadata = upload.keepBindings && upload.keepBindings.length > 0 ? { ...upload.metadata, keep_bindings: upload.keepBindings } : upload.metadata;
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
      form.append(upload.moduleName, new Blob([upload.module], { type: "application/javascript+module" }), upload.moduleName);
      const reply = await send("put the app online", "PUT", script(accountId, name), form);
      const id = (reply.result as { id?: unknown } | null | undefined)?.id;
      return typeof id === "string" && id !== "" ? id : null;
    },

    /** The deployment serving traffic, or null when the Worker has none. A split between versions is refused, since VEMI never makes one. */
    async getDeployment(accountId: string, name: string): Promise<Deployment | null> {
      const reply = await sendOrAbsent("read the running version", "GET", `${script(accountId, name)}/deployments`);
      const rows = (reply?.result as { deployments?: { id: string; versions?: { version_id: string }[] }[] } | null | undefined)?.deployments ?? [];
      const latest = rows[0];
      if (latest === undefined) return null;
      const versions = latest.versions ?? [];
      const only = versions[0];
      if (versions.length !== 1 || only === undefined || typeof only.version_id !== "string") {
        throw new SetupError("Cloudflare would not read the running version: it is split between versions.");
      }
      return { id: latest.id, versionId: only.version_id };
    },

    /** The Worker's versions, newest first. */
    async listVersions(accountId: string, name: string): Promise<WorkerVersion[]> {
      const reply = await send("list the earlier versions", "GET", `${script(accountId, name)}/versions?per_page=100`, undefined);
      const rows = ((reply.result as { items?: { id: string; number?: number }[] } | undefined)?.items ?? []) as { id: string; number?: number }[];
      return rows.map((row) => ({ id: row.id, number: typeof row.number === "number" ? row.number : null }));
    },

    /** Makes one version serve all traffic. `force` is for a refusal that names a changed secret. */
    async deployVersion(accountId: string, name: string, versionId: string, options: { force?: boolean } = {}): Promise<Deployment> {
      const query = options.force === true ? "?force=true" : "";
      const reply = await send("switch to that version", "POST", `${script(accountId, name)}/deployments${query}`, {
        strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { "workers/message": "VEMI go back" },
      });
      const result = reply.result as { id: string; versions?: { version_id: string }[] };
      return { id: result.id, versionId: result.versions?.[0]?.version_id ?? versionId };
    },

    /** The database's Time Travel bookmark for now. */
    async getBookmark(accountId: string, databaseId: string): Promise<string> {
      const reply = await send("read the data restore point", "GET", `${acct(accountId)}/d1/database/${encodeURIComponent(databaseId)}/time_travel/bookmark`, undefined);
      const bookmark = (reply.result as { bookmark?: unknown } | undefined)?.bookmark;
      if (typeof bookmark !== "string" || bookmark === "") throw new SetupError("Cloudflare would not read the data restore point: it sent none.");
      return bookmark;
    },

    async getSchedules(accountId: string, name: string): Promise<string[]> {
      const reply = await send("read the reminder clock", "GET", `${script(accountId, name)}/schedules`, undefined);
      const rows = ((reply.result as { schedules?: { cron: string }[] } | undefined)?.schedules ?? []) as { cron: string }[];
      return rows.map((row) => row.cron);
    },

    async setSchedules(accountId: string, name: string, crons: string[]): Promise<void> {
      await send("set the reminder clock", "PUT", `${script(accountId, name)}/schedules`, crons.map((cron) => ({ cron })));
    },

    async getWorkersDev(accountId: string, name: string): Promise<boolean> {
      const reply = await send("read the address", "GET", `${script(accountId, name)}/subdomain`, undefined);
      return (reply.result as { enabled?: boolean } | undefined)?.enabled === true;
    },

    async setWorkersDev(accountId: string, name: string, enabled: boolean): Promise<void> {
      await send("turn the address on", "POST", `${script(accountId, name)}/subdomain`, { enabled });
    },
  };

  // A 200 whose body is not the shape a call reads would otherwise surface as a TypeError and a
  // vague "something went wrong". Every call answers a sentence instead.
  const guarded = {} as typeof calls;
  for (const name of Object.keys(calls) as (keyof typeof calls)[]) {
    const call = calls[name] as (...args: never[]) => Promise<unknown>;
    (guarded as Record<string, unknown>)[name] = async (...args: never[]): Promise<unknown> => {
      try {
        return await call(...args);
      } catch (error) {
        if (error instanceof SetupError) throw error;
        throw new SetupError("Cloudflare answered in a way setup could not read. Try again in a minute.");
      }
    };
  }
  return guarded;
}

export type Cloudflare = ReturnType<typeof createCloudflare>;
