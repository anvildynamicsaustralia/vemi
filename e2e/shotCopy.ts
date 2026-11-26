import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, request, type APIRequestContext } from "@playwright/test";

/**
 * A fresh copy for pictures: the real Worker, run by `wrangler dev` on a local database in a
 * temporary folder, with its first account claimed and first run switched off. `seedExamples`
 * fills it with plain example names. Shared by the landing and docs screenshot specs.
 */

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = ROOT;
const WRANGLER = join(API_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const OPERATOR_EMAIL = "operator@example.test";
const PASSWORD = "an e2e operator password";

/** No picture is bigger than this. */
export const MAX_BYTES = 300 * 1024;

export interface Copy {
  readonly origin: string;
  readonly api: APIRequestContext;
  readonly stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export async function startCopy(): Promise<Copy> {
  const persist = mkdtempSync(join(tmpdir(), "vemi-e2e-shots-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const envFile = join(persist, "e2e.env");
  writeFileSync(envFile, Object.entries({
    ORIGIN: origin,
    OPERATOR_EMAIL,
    SESSION_SECRET: "e2e-session-secret",
  }).map(([key, value]) => `${key}=${value}`).join("\n"));

  let output = "";
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  execFileSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: API_ROOT, env, stdio: "pipe",
  });
  const child: ChildProcess = spawn(process.execPath, [
    WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(await freePort()), "--persist-to", persist, "--env-file", envFile,
    "--local-upstream", `127.0.0.1:${port}`, "--show-interactive-dev-session=false",
  ], { cwd: API_ROOT, env });
  child.stdout?.on("data", (d) => { output += String(d); });
  child.stderr?.on("data", (d) => { output += String(d); });

  const deadline = Date.now() + 120_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    up = (await fetch(`${origin}/auth/me`).catch(() => null))?.status === 200;
    if (!up) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!up) throw new Error(`timed out waiting for wrangler dev to answer\n${output.slice(-3000)}`);

  const api = await request.newContext();
  const claimed = await api.post(`${origin}/auth/claim`, { data: { email: OPERATOR_EMAIL, password: PASSWORD }, headers: { origin } });
  expect(claimed.status()).toBe(200);
  // A seeded copy is not a new person: first run is over before anything draws.
  const skipped = await api.patch(`${origin}/api/first-run`, { data: { step: null }, headers: { origin } });
  expect(skipped.status()).toBe(200);

  return {
    origin,
    api,
    stop: async () => {
      await api.dispose();
      if (child.pid !== undefined) {
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
      try {
        rmSync(persist, { recursive: true, force: true });
      } catch {
        // workerd can hold the folder for a moment after it stops. It is a temporary folder.
      }
    },
  };
}

export async function send<T>(copy: Copy, method: "post" | "patch", path: string, data: object): Promise<T> {
  const response = await copy.api[method](`${copy.origin}${path}`, { data, headers: { origin: copy.origin } });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
}

export const isoDay = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface Seeded {
  readonly venture: string;
  readonly project: string;
}

/** Two spaces, three projects and six tasks, three of them on today. Returns the first space and its first project. */
export async function seedExamples(copy: Copy): Promise<Seeded> {
  const studio = await send<{ id: string }>(copy, "post", "/api/ventures", { name: "Garden Studio" });
  const home = await send<{ id: string }>(copy, "post", "/api/ventures", { name: "Home" });
  const catalogue = await send<{ id: string }>(copy, "post", "/api/projects", { ventureId: studio.id, name: "Spring catalogue" });
  await send(copy, "post", "/api/projects", { ventureId: studio.id, name: "Website refresh" });
  await send(copy, "post", "/api/projects", { ventureId: home.id, name: "Kitchen repaint" });
  const tasks: readonly (readonly [string, string, string | null, string | null])[] = [
    [studio.id, "Photograph the new plants", catalogue.id, isoDay(0)],
    [studio.id, "Write the catalogue intro", catalogue.id, isoDay(0)],
    [studio.id, "Order printed samples", catalogue.id, isoDay(2)],
    [studio.id, "Choose a cover colour", catalogue.id, null],
    [home.id, "Buy paint and brushes", null, isoDay(0)],
    [home.id, "Book the electrician", null, isoDay(3)],
  ];
  for (const [ventureId, title, projectId, due] of tasks) {
    await send(copy, "post", "/api/tasks", {
      ventureId,
      title,
      ...(projectId ? { projectId } : {}),
      ...(due ? { dueOn: due } : {}),
      ...(due === isoDay(0) ? { pickedOn: due } : {}),
    });
  }
  return { venture: studio.id, project: catalogue.id };
}
