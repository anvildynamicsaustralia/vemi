/**
 * How the setup page reaches Cloudflare. Cloudflare's API answers no browser call from another
 * origin (phases/notes_setup-helper.md, finding 1), so every call goes to the front's relay as
 * one small JSON request: `POST /get/relay/start` for a ticket, then `POST /get/relay` for each
 * call, with the key in the body. The result is a `fetch` shaped like the real one, so the
 * shared client (`createCloudflare`) runs unchanged on top of it.
 *
 * The key is held in this closure and sent in the body of a call; it is never kept anywhere.
 */
import { CLOUDFLARE_BASE, SetupError, type FetchLike } from "../../shared/setup/cloudflareApi.js";

export const RELAY_PATH = "/get/relay";
export const RELAY_START_PATH = "/get/relay/start";

interface Part {
  name: string;
  filename?: string;
  type?: string;
  text: string;
}

export interface RelayOptions {
  /** The key for every call. */
  token: string;
  /** The page's own `fetch`. */
  fetch?: typeof fetch;
}

const JSON_TYPE = { "content-type": "application/json" };

/** A relay's own refusal looks like `{ error }`; Cloudflare's own answers carry `success`. */
function relayRefusal(text: string): string | null {
  try {
    const value = JSON.parse(text) as { error?: unknown; success?: unknown };
    return typeof value.error === "string" && value.success === undefined ? value.error : null;
  } catch {
    return null;
  }
}

async function partsOf(form: FormData): Promise<Part[]> {
  const parts: Part[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") parts.push({ name, text: value });
    else parts.push({ name, filename: value.name, type: value.type, text: await value.text() });
  }
  return parts;
}

export function createRelayFetch(options: RelayOptions) {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const { token } = options;
  let ticket: string | null = null;

  /** One ticket for the whole setup. Throws a sentence when the relay is busy or out of reach. */
  async function start(): Promise<string> {
    let response: Response;
    try {
      response = await doFetch(RELAY_START_PATH, { method: "POST", headers: JSON_TYPE, body: "{}" });
    } catch {
      throw new SetupError("Setup could not be reached. Check your connection, or use the Deploy button.");
    }
    const text = await response.text();
    if (!response.ok) throw new SetupError(relayRefusal(text) ?? "Setup could not be started. Use the Deploy button instead.", response.status);
    try {
      const value = JSON.parse(text) as { ticket?: unknown };
      if (typeof value.ticket === "string") return value.ticket;
    } catch {
      // Falls through to the sentence below.
    }
    throw new SetupError("Setup could not be started. Use the Deploy button instead.");
  }

  async function send(url: string, init: RequestInit): Promise<Response> {
    if (!url.startsWith(CLOUDFLARE_BASE)) throw new SetupError("That address is not one setup talks to.");
    const path = url.slice(CLOUDFLARE_BASE.length);
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload: Record<string, unknown> = { token, method: (init.method ?? "GET").toUpperCase(), path };
    // The upload session's own key goes in the place the account key takes elsewhere.
    if (bearer !== "" && bearer !== token) payload["bearer"] = bearer;
    if (typeof init.body === "string") payload["body"] = JSON.parse(init.body) as unknown;
    else if (init.body instanceof FormData) payload["form"] = await partsOf(init.body);

    for (let attempt = 0; attempt < 2; attempt++) {
      ticket ??= await start();
      let response: Response;
      try {
        response = await doFetch(RELAY_PATH, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ ...payload, ticket }) });
      } catch {
        throw new SetupError("Setup could not be reached. Check your connection, or use the Deploy button.");
      }
      const text = await response.text();
      const refusal = response.ok ? null : relayRefusal(text);
      // A ticket that ran out or lapsed is replaced once; anything else the relay says is told as it is.
      if (refusal !== null && response.status === 403 && /ticket|run out/i.test(refusal) && attempt === 0) {
        ticket = null;
        continue;
      }
      if (refusal !== null) {
        const body = JSON.stringify({ success: false, errors: [{ message: refusal }], result: null });
        return new Response(body, { status: 400, headers: JSON_TYPE });
      }
      return new Response(text, { status: response.status, headers: JSON_TYPE });
    }
    throw new SetupError("Setup could not continue. Start again.");
  }

  const relayFetch: FetchLike = (url, init = {}) => send(url, init);
  return {
    fetch: relayFetch,
    /** Gets the ticket now, so a busy day shows before anything else is asked. */
    async ready(): Promise<void> {
      ticket ??= await start();
    },
  };
}
