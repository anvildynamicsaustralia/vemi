/**
 * `POST /mcp`: the one endpoint an app speaks to once it has been let in.
 *
 * Plain JSON in and out, one request per POST, nothing kept between calls: no session, no
 * stream, no Durable Object. Two eras share the address. A request carrying the 2026-07-28
 * per-request `_meta` is served by that revision (headers checked against the body); an
 * `initialize` gets the older handshake answer, and the older follow-up requests are served
 * the same way, since nothing here depends on the session.
 */
import { capBody } from "./body.js";
import { callTool, toolList, type LevelWords, type ToolDeps } from "./connectorTools.js";
import type { Changes } from "./connectorChanges.js";
import type { ConnectorGrant } from "./store.js";

const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const SERVER = { name: "VEMI", version: "1" };
const BODY_MAX = 100_000;

export interface McpDeps extends ToolDeps {
  /** The page's own origin: the only one a browser may speak from. */
  readonly origin: string;
  readonly words?: LevelWords;
  /** Where what an app does is kept, so the person can undo it. */
  readonly changes?: Changes;
}

export interface Mcp {
  handle(request: Request, grant: ConnectorGrant, waitUntil: (work: Promise<unknown>) => void): Promise<Response>;
}

type Id = string | number | null;

/** What an AI app is told on an account with full encryption on or being turned on. The web app shows the same line. */
export const ENCRYPTED = "This VEMI is fully encrypted, so AI apps can't read it.";

function send(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const failure = (status: number, id: Id, code: number, message: string, data?: unknown): Response =>
  send(status, { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

export function createMcp(deps: McpDeps): Mcp {
  /** The grant owner's own level names, read each request so a rename shows at once. */
  const wordsOf = async (owner: string): Promise<LevelWords> =>
    deps.words ?? (await deps.store.appearance(owner)).levelNames;

  async function handle(request: Request, grant: ConnectorGrant, waitUntil: (work: Promise<unknown>) => void): Promise<Response> {
    if (request.method !== "POST") return send(405, { error: "POST only" }, { allow: "POST" });
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== deps.origin) return send(403, { error: "cross-origin request refused" });

    const capped = await capBody(request, BODY_MAX);
    if (!capped.ok) return failure(413, null, -32600, "the request is too large");
    const raw = capped.text;
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return failure(400, null, -32700, "the body is not valid JSON"); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return failure(400, null, -32600, "send one JSON-RPC request per POST");
    }
    const m = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return failure(400, null, -32600, "not a JSON-RPC 2.0 request");
    // A notification has no id and is only acknowledged.
    if (m.id === undefined) return new Response(null, { status: 202 });
    if (typeof m.id !== "string" && typeof m.id !== "number") return failure(400, null, -32600, "id must be text or a number");
    const id: Id = m.id;
    const params = typeof m.params === "object" && m.params !== null && !Array.isArray(m.params) ? (m.params as Record<string, unknown>) : {};

    const meta = (typeof params._meta === "object" && params._meta !== null ? (params._meta as Record<string, unknown>) : {})[META_VERSION];
    const modern = m.method !== "initialize" && typeof meta === "string";
    if (modern) {
      if (meta !== MODERN) return failure(400, id, -32022, "Unsupported protocol version", { supported: [MODERN, ...LEGACY], requested: meta });
      const name = typeof params.name === "string" ? params.name : null;
      if (
        request.headers.get("mcp-protocol-version") !== meta ||
        request.headers.get("mcp-method") !== m.method ||
        (m.method === "tools/call" && request.headers.get("mcp-name") !== name)
      ) return failure(400, id, -32020, "the headers do not match the request");
    }
    const ok = (result: Record<string, unknown>): Response =>
      send(200, { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result } : result });

    // A fully encrypted account holds text the server cannot read, so an AI app is let in to nothing.
    if (m.method === "tools/list" || m.method === "tools/call") {
      const { encryption } = await deps.store.appearance(grant.owner);
      if (encryption === "on" || encryption === "turning_on") {
        return m.method === "tools/call"
          ? ok({ isError: true, content: [{ type: "text", text: ENCRYPTED }] })
          : failure(modern ? 403 : 200, id, -32000, ENCRYPTED);
      }
    }

    switch (m.method) {
      case "ping":
        return ok({});
      case "initialize": {
        const asked = params.protocolVersion;
        const version = (LEGACY as readonly unknown[]).includes(asked) ? asked : LEGACY[0];
        return send(200, { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER } });
      }
      case "server/discover":
        return ok({
          supportedVersions: [MODERN, ...LEGACY], capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER },
        });
      case "tools/list":
        return ok({ tools: toolList(await wordsOf(grant.owner)) });
      case "tools/call": {
        if (typeof params.name !== "string") return failure(400, id, -32602, "name is needed");
        const run = { ...deps, record: deps.changes?.recorder({ id: grant.id, clientName: grant.clientName }), publish: (owner: string, change: Parameters<ToolDeps["publish"]>[1]) => waitUntil(Promise.resolve(deps.publish(owner, change))) };
        const result = await callTool(run, grant.owner, params.name, params.arguments, await wordsOf(grant.owner));
        if (result === null) return failure(modern ? 400 : 200, id, -32602, `there is no tool called ${params.name}`);
        return ok({ ...result });
      }
      default:
        return failure(modern ? 404 : 200, id, -32601, `there is no method ${m.method}`);
    }
  }

  return { handle };
}
