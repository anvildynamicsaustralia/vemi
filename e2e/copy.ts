import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one place the e2e specs start a real copy: the Worker, run by `wrangler dev` on a local
 * database in a temporary folder with every migration applied. A spec claims its account (or
 * not) on top of what this returns, and calls `stop` when done.
 */

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
export const OPERATOR_EMAIL = "operator@example.test";
export const PASSWORD = "an e2e operator password";

export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Ends a child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  } else {
    child.kill("SIGTERM");
  }
}

export interface Server {
  readonly origin: string;
  readonly port: number;
  /** The temporary folder holding the local database. */
  readonly persist: string;
  /** What wrangler has said so far, for an error message. */
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

export interface ServerOptions {
  /** Names the temporary folder. */
  readonly name: string;
  /** The host the copy answers on. Default `127.0.0.1`. */
  readonly host?: string;
  /** The variables to set. Default: ORIGIN, OPERATOR_EMAIL and a session secret. */
  readonly vars?: (origin: string, port: number) => Record<string, string>;
  /** Time allowed for the copy to answer. Default two minutes. */
  readonly waitMs?: number;
}

export async function startServer(options: ServerOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const persist = mkdtempSync(join(tmpdir(), `vemi-e2e-${options.name}-`));
  const port = await freePort();
  const origin = `http://${host}:${port}`;
  const envFile = join(persist, "e2e.env");
  const vars = options.vars?.(origin, port) ?? { ORIGIN: origin, OPERATOR_EMAIL, SESSION_SECRET: "e2e-session-secret" };
  writeFileSync(envFile, Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n"));

  let output = "";
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  execFileSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: ROOT, env, stdio: "pipe",
  });
  const child: ChildProcess = spawn(process.execPath, [
    WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(await freePort()), "--persist-to", persist, "--env-file", envFile,
    "--local-upstream", `${host}:${port}`, "--show-interactive-dev-session=false",
  ], { cwd: ROOT, env });
  child.stdout?.on("data", (d) => { output += String(d); });
  child.stderr?.on("data", (d) => { output += String(d); });

  const stop = async (): Promise<void> => {
    killTree(child);
    try {
      rmSync(persist, { recursive: true, force: true });
    } catch {
      // workerd can hold the folder for a moment after it stops. It is a temporary folder.
    }
  };

  const deadline = Date.now() + (options.waitMs ?? 120_000);
  let up = false;
  while (Date.now() < deadline && !up) {
    up = (await fetch(`${origin}/auth/me`).catch(() => null))?.status === 200;
    if (!up) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!up) {
    await stop();
    throw new Error(`timed out waiting for wrangler dev to answer\n${output.slice(-3000)}`);
  }
  return { origin, port, persist, output: () => output, stop };
}
