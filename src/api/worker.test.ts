import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_ROOT } from "./testing/d1.js";

/**
 * The whole Worker, run by `wrangler dev` the way Cloudflare runs it: the bundled entry,
 * D1 with the migrations applied by wrangler, the Durable Object holding real WebSockets,
 * and the JSON export. The first sign-up claims the copy through `/auth/claim` (and with
 * `OPERATOR_EMAIL` set, only that address can, in a second copy at the end); no mail exists.
 * Everything below goes over HTTP.
 */

const WRANGLER = join(API_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const OWNER_EMAIL = "owner@example.test";
const OPERATOR_EMAIL = "operator@example.test";
const PASSWORD = "an e2e operator password";

let origin = "";
let output = "";
let cookie = "";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}\n--- wrangler said ---\n${output.slice(-4000)}`);
}

const request = (method: string, path: string, body?: unknown): Promise<Response> => fetch(`${origin}${path}`, {
  method,
  headers: {
    origin,
    ...(cookie ? { cookie } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** A WebSocket with its messages queued, so none is missed between awaits. */
async function openSocket() {
  const queue: string[] = [];
  const waiting: ((message: string) => void)[] = [];
  // Node's WebSocket takes headers, which a browser's does not need: it sends the cookie itself.
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/live`, { headers: { cookie, origin } } as unknown as string[]);
  socket.addEventListener("message", (event) => {
    const message = String(event.data);
    const next = waiting.shift();
    if (next) next(message);
    else queue.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`the WebSocket did not open\n${output.slice(-2000)}`)));
  });
  return {
    next: (ms = 10_000): Promise<string> => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message arrived")), ms);
        waiting.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    close: () => socket.close(),
  };
}

interface Booted {
  readonly child: ChildProcess;
  readonly persist: string;
  readonly origin: string;
}

/** Starts a copy under `wrangler dev` with these variables in its env file, and waits for it to answer. */
async function boot(vars: Readonly<Record<string, string>>): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "vemi-worker-"));
  const port = await freePort();
  const at = `http://127.0.0.1:${port}`;

  const envFile = join(dir, "e2e.env");
  // No ORIGIN, SESSION_SECRET or VAPID pair: a copy starts bare, takes its origin from the
  // first request and makes its own keys. An empty file is still a file.
  writeFileSync(envFile, Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");

  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  execFileSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", dir], {
    cwd: API_ROOT, env, stdio: "pipe",
  });

  // The config has a custom-domain route, so `wrangler dev` would otherwise stand in for that
  // domain and the origin header the tests send would no longer match the ORIGIN they set.
  const started = spawn(process.execPath, [
    WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(await freePort()), "--persist-to", dir, "--env-file", envFile,
    "--local-upstream", `127.0.0.1:${port}`, "--show-interactive-dev-session=false",
  ], { cwd: API_ROOT, env });
  started.stdout?.on("data", (d) => { output += String(d); });
  started.stderr?.on("data", (d) => { output += String(d); });

  await waitFor(async () => (await fetch(`${at}/auth/me`).catch(() => null))?.status === 200, 120_000, "wrangler dev to answer");
  return { child: started, persist: dir, origin: at };
}

function stop(copy: Booted | undefined): void {
  if (copy === undefined) return;
  if (copy.child.pid !== undefined) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(copy.child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
    } else {
      copy.child.kill("SIGTERM");
    }
  }
  try {
    rmSync(copy.persist, { recursive: true, force: true });
  } catch {
    // workerd can hold the directory for a moment after it stops. It is a temp directory.
  }
}

let main: Booted | undefined;
let guarded: Booted | undefined;
let claimed: Booted | undefined;

beforeAll(async () => {
  // The default copy: no OPERATOR_EMAIL, so the first sign-up owns it.
  main = await boot({});
  origin = main.origin;
}, 240_000);

afterAll(async () => {
  stop(main);
  stop(guarded);
  stop(claimed);
}, 30_000);

describe("the Worker, run by wrangler", () => {
  it("starts empty, behind sign-in, and the first sign-up claims the copy with an email and a password", async () => {
    expect((await request("GET", "/api/overview")).status).toBe(401);
    expect(await (await request("GET", "/auth/me")).json()).toMatchObject({ signedIn: false, claimable: true });

    const claimed = await request("POST", "/auth/claim", { email: OWNER_EMAIL, password: PASSWORD });
    expect(claimed.status).toBe(200);
    expect(await claimed.clone().json()).toMatchObject({ signedIn: true, recoveryCode: expect.any(String) });
    cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await request("POST", "/auth/claim", { email: "second@example.test", password: PASSWORD })).status).toBe(409);
    expect(await (await fetch(`${origin}/auth/me`)).json()).toMatchObject({ signedIn: false, claimable: false });

    expect(await (await request("GET", "/api/overview")).json()).toEqual({ ventures: [], archivedVentures: 0 });
  });

  it("makes a push key pair on the first call, with no VAPID secret set", async () => {
    const first = await (await request("GET", "/api/push/key")).json() as { publicKey: string };
    expect(first.publicKey).toHaveLength(87);
    expect((await (await request("GET", "/api/push/key")).json() as { publicKey: string }).publicKey).toBe(first.publicKey);
  });

  it("shows two open clients each other's changes over the WebSocket", async () => {
    const first = await openSocket();
    const second = await openSocket();

    const venture = await (await request("POST", "/api/ventures", { name: "Studios" })).json() as { id: string };
    const [a, b] = await Promise.all([first.next(), second.next()]);
    expect(JSON.parse(a)).toEqual({ kind: "ventures", id: venture.id, ventureId: venture.id });
    expect(b).toBe(a);

    const task = await (await request("POST", "/api/tasks", { ventureId: venture.id, title: "Blockout the chase" })).json() as { id: string };
    const [c, d] = await Promise.all([first.next(), second.next()]);
    expect(JSON.parse(c)).toEqual({ kind: "tasks", id: task.id, ventureId: venture.id });
    expect(d).toBe(c);

    first.close();
    second.close();
  });

  it("serves the whole account as a JSON export", async () => {
    const exported = await request("GET", "/api/export");
    expect(exported.status).toBe(200);
    const doc = await exported.json() as { tables: { venture: { name: string }[]; task: { title: string }[] } };
    expect(doc.tables.venture.map((r) => r.name)).toEqual(["Studios"]);
    expect(doc.tables.task.map((r) => r.title)).toEqual(["Blockout the chase"]);
  });
});

describe("a copy with SETUP_CLAIM set, run by wrangler", () => {
  it("refuses the first sign-up until /setup/claim takes the code once, then lets it make the owner", async () => {
    const code = "worker-test-setup-code";
    claimed = await boot({ SETUP_CLAIM: code, SETUP_FROM: "https://setup.example.org" });
    const at = claimed.origin;
    const post = (path: string, body: unknown): Promise<Response> => fetch(`${at}${path}`, {
      method: "POST", headers: { origin: at, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(await (await fetch(`${at}/auth/me`)).json()).toMatchObject({ signedIn: false, claimable: false });
    expect((await post("/auth/claim", { email: OWNER_EMAIL, password: PASSWORD })).status).toBe(409);
    expect((await post("/setup/claim", { code: "wrong", token: "t", keepUpdated: false })).status).toBe(403);
    expect((await post("/setup/claim", { code, token: "t", keepUpdated: true })).status).toBe(200);
    expect((await post("/setup/claim", { code, token: "t", keepUpdated: true })).status).toBe(403);
    expect(await (await fetch(`${at}/auth/me`)).json()).toMatchObject({ signedIn: false, claimable: true });
    expect((await post("/auth/claim", { email: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await post("/auth/claim", { email: "second@example.test", password: PASSWORD })).status).toBe(409);
  }, 240_000);
});

describe("a copy with OPERATOR_EMAIL set, run by wrangler", () => {
  it("lets only that address claim, and nobody once it has", async () => {
    guarded = await boot({ OPERATOR_EMAIL });
    const at = guarded.origin;
    const post = (body: unknown): Promise<Response> => fetch(`${at}/auth/claim`, {
      method: "POST", headers: { origin: at, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(await (await fetch(`${at}/auth/me`)).json()).toMatchObject({ signedIn: false, claimable: true });
    expect((await post({ email: OWNER_EMAIL, password: PASSWORD })).status).toBe(403);
    expect((await post({ email: OPERATOR_EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await post({ email: OPERATOR_EMAIL, password: PASSWORD })).status).toBe(409);
    expect(await (await fetch(`${at}/auth/me`)).json()).toMatchObject({ signedIn: false, claimable: false });
  }, 240_000);
});
