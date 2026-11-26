import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createRelay, type KeyValue } from "../src/front/relay.js";
import { createFakeCloudflare } from "../src/shared/setup/fakeCloudflare.js";
import { claimFor, moveAddress } from "../src/shared/setup/getFlow.js";
import { buildManifest, latestText, manifestText, type ReleaseFile } from "../src/shared/setup/releaseManifest.js";

/**
 * Nothing passes through the middle (move-to-cloud, Task 9). The built helper page, at `/get/`,
 * is served with the headers `public/_headers` gives it, from a small local server that stands in
 * for the front (the built files, a tiny release, the real relay in front of an in-memory
 * Cloudflare). The new copy is stubbed at a workers.dev address. The move is driven from the file
 * picker to the done screen, and every request the page and its context make is recorded. The
 * document and the password reach exactly one host, the new copy; the code, the password and the
 * document's text appear in no other request, and nothing goes to a third party.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "dist", "web");
const ACCOUNT = "Sam's Cloudflare";
const ACCOUNT_ID = "acct-test";
const SUBDOMAIN = "test-sub";
const NAME = "mine";
const COPY = `https://${NAME}.${SUBDOMAIN}.workers.dev`;
const KEY = "e2e-key-middleman-0123456789";
const PASSWORD = "a password only the new copy sees";
const EMAIL = "owner@example.test";
const NOTE = "the secret note text 7731";
const DOCUMENT = {
  format: "vemi-export", version: 2, exportedAt: "2026-11-22T00:00:00.000Z", about: "test",
  settings: { levelNames: { space: "Area" } },
  tables: { venture: [{ id: "v1", name: "Home" }, { id: "v2", name: "Work" }], task: [{ id: "t1", title: NOTE }], note: [{ id: "n1", body: NOTE }] },
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff",
};

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string): ReleaseFile => ({ path, bytes: enc(text) });

async function tinyRelease(): Promise<Map<string, Uint8Array>> {
  const worker = file("worker/index.js", "export default {};");
  const client = [file("/index.html", "<html></html>"), file("/assets/app.js", "console.log(1)"), file("/get/index.html", "<html>get</html>")];
  const migrations = [file("0001_a.sql", "CREATE TABLE a (x TEXT);")];
  const manifest = await buildManifest({ version: "0.1.0", notesFile: "## 0.1.0\n\nFirst.\n", compatibilityDate: "2026-09-11", issuedAt: "2026-11-25T00:00:00.000Z", bindings: [], variables: [], worker, client, migrations });
  const text = manifestText(manifest);
  return new Map<string, Uint8Array>([
    ["/release/latest.json", enc(await latestText("0.1.0", text))],
    ["/release/0.1.0/manifest.json", enc(text)],
    ["/release/0.1.0/worker/index.js", worker.bytes],
    ...client.map((f): [string, Uint8Array] => [`/release/0.1.0/client${f.path}`, f.bytes]),
    ...migrations.map((f): [string, Uint8Array] => [`/release/0.1.0/migrations/${f.path}`, f.bytes]),
  ]);
}

/** The headers `public/_headers` sends for a path: every block that matches, in file order, `!` lines removing one. */
function headersFor(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of readFileSync(join(ROOT, "public", "_headers"), "utf8").split(/\r?\n\s*\r?\n/)) {
    const [pattern = "", ...lines] = block.split(/\r?\n/).filter((l) => l.trim() !== "");
    const rule = pattern.trim();
    const hit = rule.endsWith("*") ? path.startsWith(rule.slice(0, -1)) : path === rule;
    if (!hit) continue;
    for (const line of lines) {
      const text = line.trim();
      if (text.startsWith("!")) { delete out[text.slice(1).trim().toLowerCase()]; continue; }
      const at = text.indexOf(":");
      if (at > 0) out[text.slice(0, at).trim().toLowerCase()] = text.slice(at + 1).trim();
    }
  }
  return out;
}

function memoryKv(): KeyValue {
  const values = new Map<string, string>();
  return { get: async (key) => values.get(key) ?? null, put: async (key, value) => void values.set(key, value) };
}

test("the helper moves a file to the new copy and nothing goes anywhere else", async ({ browser }) => {
  test.setTimeout(180_000);
  const release = await tinyRelease();
  const code = await claimFor(ACCOUNT_ID, NAME);
  const fake = createFakeCloudflare({ token: KEY, accountName: ACCOUNT, subdomain: SUBDOMAIN });

  let origin = "";
  const relay = (): ReturnType<typeof createRelay> =>
    createRelay({ secret: "e2e-relay-secret", day: memoryKv(), now: () => new Date(), fetch: (url, init) => fake.fetch(url, init), origin });
  let theRelay: ReturnType<typeof createRelay> | null = null;
  const body = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", origin).pathname;
      if (path === "/get/relay/start" || path === "/get/relay") {
        theRelay ??= relay();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
        const payload = req.method === "POST" ? await body(req) : undefined;
        const asked = new Request(`${origin}${path}`, { method: req.method, headers, body: payload === undefined ? undefined : new Uint8Array(payload) });
        const answer = req.method === "OPTIONS" ? theRelay.preflight(asked) : path === "/get/relay" ? await theRelay.forward(asked) : await theRelay.start(asked);
        res.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
        res.end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
      const kept = release.get(path);
      if (kept !== undefined) { res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }); res.end(kept); return; }
      const rel = path === "/get" || path === "/get/" ? "/get/index.html" : path;
      const full = normalize(join(WEB, rel));
      if (!full.startsWith(WEB)) { res.writeHead(403); res.end("no"); return; }
      try {
        const content = readFileSync(full);
        res.writeHead(200, { ...headersFor(path === "/get" ? "/get/" : path), "content-type": TYPES[extname(full)] ?? "application/octet-stream" });
        res.end(content);
      } catch {
        res.writeHead(404); res.end("not found");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const seen: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  context.on("request", (request) => {
    seen.push({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() ?? "" });
  });
  const refused: string[] = [];
  await context.route("https://dash.cloudflare.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Cloudflare</title>" }));
  // The new copy, stubbed: it takes the hand-over and the move, and answers a move with a finished copy.
  await context.route(/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\//, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname;
    const answer = path === "/setup/move"
      ? { counts: { venture: 2, task: 1, note: 1 }, locked: [], ids: {}, recoveryCode: "recovery-code", handOver: "hand-over" }
      : { claimed: true };
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(answer) });
  });

  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) refused.push(message.text()); });

  await page.goto(`${origin}/get/?from=local`);
  await page.getByRole("button", { name: "I have one" }).click();
  await page.getByLabel("Your key").fill(KEY);
  await expect(page.getByText(`Connected to ${ACCOUNT}`)).toBeVisible();
  await page.getByRole("button", { name: /^Next/ }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(NAME);
  await expect(page.getByText(`${NAME}.${SUBDOMAIN}.workers.dev`)).toBeVisible();
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("A password for your own VEMI").fill(PASSWORD);
  await page.getByRole("button", { name: /^Build my VEMI/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Built" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Next/ }).click();

  // The helper's move step waits for the file; the person picks it, and the move runs.
  await page.getByLabel("Your export file").setInputFiles({ name: "vemi-export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(DOCUMENT)) });
  await expect(page.locator("li.get-row.ok", { hasText: "Copying your stuff" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Next/ }).click();
  await page.getByRole("button", { name: /^Finish/ }).click();
  await expect(page.getByRole("link", { name: /^Open my VEMI/ }).first()).toBeVisible({ timeout: 60_000 });
  // The done screen tells the counts in the person's own level names.
  await expect(page.locator(".get-counts")).toContainText("2 Areas");
  await expect(page.locator(".get-counts")).toContainText("1 Task");
  await expect(page.getByRole("link", { name: /^Open my VEMI/ }).first()).toHaveAttribute("href", `${COPY}/auth/move-in?t=hand-over`);
  const shown = await page.locator("body").innerText();
  expect(shown).not.toContain(PASSWORD);
  expect(shown).not.toContain(NOTE);
  await context.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const sent = seen.filter((r) => r.url === moveAddress(COPY) && r.method === "POST");
  expect(sent).toHaveLength(1);
  const posted = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
  expect(posted["password"]).toBe(PASSWORD);
  expect(posted["code"]).toBe(code);
  expect(posted["document"]).toEqual(DOCUMENT);

  // Every request, by host: the helper's own page (and its relay) and the new copy, or an
  // inline or blob address. No direct call to Cloudflare, no third party.
  const hosts = new Set(seen.filter((r) => /^https?:/.test(r.url)).map((r) => new URL(r.url).host));
  hosts.delete("dash.cloudflare.com");
  expect([...hosts].sort()).toEqual([new URL(origin).host, new URL(COPY).host].sort());
  expect(seen.filter((r) => r.url.includes("api.cloudflare.com"))).toEqual([]);

  // The password, the document's text and the email appear in no request but the one to the new
  // copy's move door; the code reaches the new copy and the relay that sets it up, nothing else.
  for (const request of seen) {
    if (request === sent[0]) continue;
    const text = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body}`;
    for (const secret of [PASSWORD, NOTE, EMAIL]) expect(text, `${request.method} ${request.url}`).not.toContain(secret);
    // The build uploads the code to the new copy as its claim binding, through the relay; nowhere else.
    if (text.includes(code)) {
      const at = new URL(request.url);
      const allowed = at.host === new URL(COPY).host || (at.host === new URL(origin).host && at.pathname.startsWith("/get/relay"));
      expect(allowed, request.url).toBe(true);
    }
  }
  const head = `${sent[0]?.url}\n${JSON.stringify(sent[0]?.headers)}`;
  for (const secret of [PASSWORD, code, NOTE, EMAIL]) expect(head).not.toContain(secret);
  expect(refused).toEqual([]);
  expect(errors).toEqual([]);
});
