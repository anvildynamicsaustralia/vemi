/**
 * The page's `fetch`, pointed at the database instead of the network.
 *
 * `installBridge` replaces `fetch` so that a same-origin `/api/` or `/auth/` request is carried
 * to the database worker and its answer carried back, and every other request fails with a
 * `TypeError`, the way a fetch fails offline. Nothing can leave the page, whatever asks. The
 * connector, push and setup routes stay in the app and are made unreachable here: they are not
 * on the allowed list, and `/api/connector/` and `/api/push/` are refused by name though they
 * sit under `/api/`. `/get/` is a normal navigation, not a fetch.
 *
 * A `Request` and a `Response` cannot cross a worker boundary, so each crosses as plain data:
 * `{ method, url, headers, body }` out and `{ status, headers, body }` back. `serve` is the
 * other end of the wire, on the database's side.
 */

export interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: [string, string][];
  readonly body: ArrayBuffer | null;
}

export interface WireResponse {
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: ArrayBuffer;
}

export interface BridgeOptions {
  /** The page's own origin. */
  readonly origin: string;
  /** Carries one request to the database worker and brings its answer back. */
  readonly send: (wire: WireRequest) => Promise<WireResponse>;
  /** Whose `fetch` is replaced. The page's global by default. */
  readonly target?: { fetch: typeof fetch };
}

/** Under `/api/`, but not for a page that keeps its own data. */
const REFUSED = ["/api/connector", "/api/push"];

const allowed = (path: string): boolean => {
  if (!(path.startsWith("/api/") || path.startsWith("/auth/"))) return false;
  return !REFUSED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
};

const NO_BODY = new Set([101, 204, 205, 304]);

const aborted = (): DOMException => new DOMException("The operation was aborted.", "AbortError");

/** Replaces `fetch`. Answers a function that puts the old one back. */
export function installBridge(options: BridgeOptions): () => void {
  const target = options.target ?? globalThis;
  const original = target.fetch;

  const bridged = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request: Request;
    try {
      const base = input instanceof Request ? input : new URL(typeof input === "string" ? input : input.href, options.origin);
      request = new Request(base, init);
    } catch {
      throw new TypeError("Failed to fetch");
    }
    const url = new URL(request.url);
    if (url.origin !== options.origin || !allowed(url.pathname)) throw new TypeError("Failed to fetch");
    if (request.signal.aborted) throw aborted();

    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const wire: WireRequest = { method: request.method, url: url.href, headers: [...request.headers], body };
    const answer = options.send(wire);
    // An abort ends the wait; what the database was already doing is left to finish, harmlessly.
    const signal = request.signal;
    const answered = await new Promise<WireResponse>((resolve, reject) => {
      const stop = (): void => reject(aborted());
      signal.addEventListener("abort", stop, { once: true });
      answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
    return new Response(NO_BODY.has(answered.status) ? null : answered.body, { status: answered.status, headers: answered.headers });
  };

  target.fetch = bridged as typeof fetch;
  return () => {
    target.fetch = original;
  };
}

/** The database's end of the wire: runs a request through the app and answers as data. */
export function serve(handle: (request: Request) => Promise<Response>): (wire: WireRequest) => Promise<WireResponse> {
  return async (wire) => {
    const request = new Request(wire.url, {
      method: wire.method,
      headers: wire.headers,
      ...(wire.body === null ? {} : { body: wire.body }),
    });
    const response = await handle(request);
    return { status: response.status, headers: [...response.headers], body: await response.arrayBuffer() };
  };
}
