import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { createRelay, type KeyValue } from "../src/front/relay.js";
import { createFakeCloudflare, type FakeCloudflare } from "../src/shared/setup/fakeCloudflare.js";
import { DEPLOY_LINK, KEY_LIST_LINK, SIGN_UP_LINK, claimFor } from "../src/shared/setup/getFlow.js";
import { buildManifest, latestText, manifestText, type ReleaseFile } from "../src/shared/setup/releaseManifest.js";
import { tokenLink } from "../src/shared/setup/tokenLink.js";

/**
 * The setup page in a real browser, start to finish, with no real Cloudflare and no real key.
 *
 * The page is the built one (`dist/web/get/`), served from a small local server that stands in
 * for the front: the built files, a tiny release, and the real relay in front of an in-memory
 * Cloudflare. The new copy is the real Worker, started by `wrangler dev` with the claim code the
 * page works out, so the hand-over at the end is the real `/setup/claim`. At a desk (1280 by 800)
 * and a phone (390 by 844), in both themes; a failure and Try again; a reload in the middle of
 * the build; and the switch off.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const WEB = join(ROOT, "dist", "web");
const SHOTS = join(ROOT, "e2e", "screenshots");

const SIZES = [
  { name: "desk", width: 1280, height: 800, phone: false },
  { name: "phone", width: 390, height: 844, phone: true },
] as const;
const THEMES = ["light", "dark"] as const;

const ACCOUNT = "Sam's Cloudflare";
const ACCOUNT_ID = "acct-test";
const SUBDOMAIN = "test-sub";
const NAME = "mine";
const ADDRESS = `https://${NAME}.${SUBDOMAIN}.workers.dev`;
const PASSWORD = "an e2e owner password";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff",
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string): ReleaseFile => ({ path, bytes: enc(text) });

/** A tiny release: a Worker, three client files and a migration, written the way the real script writes one. */
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

/** The policy the site sends for `/get/*`, read from the one file that holds it. */
function getPolicy(): string {
  const text = readFileSync(join(ROOT, "public", "_headers"), "utf8");
  const block = text.split(/\n\s*\n/).find((b) => b.startsWith("/get/*")) ?? "";
  const line = block.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:")) ?? "";
  return line.trim().slice("Content-Security-Policy:".length).trim();
}

function memoryKv(): KeyValue {
  const values = new Map<string, string>();
  return { get: async (key) => values.get(key) ?? null, put: async (key, value) => void values.set(key, value) };
}

interface Front {
  readonly origin: string;
  /** A fresh Cloudflare and a fresh relay for the test about to run. */
  reset(token: string, alsoAccepts?: readonly string[]): FakeCloudflare;
  readonly close: () => Promise<void>;
}

async function startFront(): Promise<Front> {
  const release = await tinyRelease();
  const policy = getPolicy();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let fake = createFakeCloudflare({ token: "unset", accountName: ACCOUNT, subdomain: SUBDOMAIN });
  let relay = createRelay({ secret: "e2e-relay-secret", day: memoryKv(), now: () => new Date(), fetch: (url, init) => fake.fetch(url, init), origin });

  const body = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;
      const send = (status: number, data: string | Uint8Array, headers: Record<string, string> = {}): void => {
        res.writeHead(status, headers);
        res.end(data);
      };
      if (path === "/get/relay/start" || path === "/get/relay") {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
        const payload = req.method === "POST" ? await body(req) : undefined;
        const asked = new Request(`${origin}${path}`, { method: req.method, headers, body: payload === undefined ? undefined : new Uint8Array(payload) });
        const answer = req.method === "OPTIONS" ? relay.preflight(asked) : path === "/get/relay" ? await relay.forward(asked) : await relay.start(asked);
        res.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
        res.end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
      const kept = release.get(path);
      if (kept !== undefined) return send(200, kept, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
      const rel = path === "/get" || path === "/get/" ? "/get/index.html" : path;
      const full = normalize(join(WEB, rel));
      if (!full.startsWith(WEB)) return send(403, "no");
      try {
        const content = readFileSync(full);
        const type = TYPES[extname(full)] ?? "application/octet-stream";
        // What the site sends for /get/*: its own policy, and the rest of the site's headers.
        return send(200, content, {
          "content-type": type, "content-security-policy": policy, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
        });
      } catch {
        return send(404, "not found");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    origin,
    reset(token, alsoAccepts) {
      fake = createFakeCloudflare({ token, alsoAccepts, accountName: ACCOUNT, subdomain: SUBDOMAIN });
      relay = createRelay({ secret: "e2e-relay-secret", day: memoryKv(), now: () => new Date(), fetch: (url, init) => fake.fetch(url, init), origin });
      return fake;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Copy {
  readonly origin: string;
  readonly api: APIRequestContext;
  readonly stop: () => Promise<void>;
}

/** The real Worker as the setup page would have left it: a claim code set, the page's origin the one allowed to hand over. */
async function startCopy(claim: string, from: string): Promise<Copy> {
  const persist = mkdtempSync(join(tmpdir(), "vemi-e2e-get-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const envFile = join(persist, "e2e.env");
  writeFileSync(envFile, Object.entries({ SESSION_SECRET: "e2e-session-secret", SETUP_CLAIM: claim, SETUP_FROM: from }).map(([k, v]) => `${k}=${v}`).join("\n"));

  let output = "";
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  execFileSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], { cwd: ROOT, env, stdio: "pipe" });
  const child: ChildProcess = spawn(process.execPath, [
    WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(await freePort()), "--persist-to", persist, "--env-file", envFile,
    "--local-upstream", `127.0.0.1:${port}`, "--show-interactive-dev-session=false",
  ], { cwd: ROOT, env });
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

let front: Front;
let copy: Copy | null = null;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  front = await startFront();
});

test.afterAll(async () => {
  await front?.close();
});

test.afterEach(async () => {
  await copy?.stop();
  copy = null;
});

const claimable = async (c: Copy): Promise<boolean> => {
  const response = await c.api.get(`${c.origin}/auth/me`);
  return ((await response.json()) as { claimable?: boolean }).claimable === true;
};

interface Run {
  readonly page: Page;
  readonly fake: FakeCloudflare;
  readonly token: string;
  /** The bodies posted to the new copy's /setup/claim. */
  readonly claims: string[];
  /** Every request the page made, as origin and path. */
  readonly seen: string[];
  readonly errors: string[];
}

/** A page at a size and a theme, with the new copy's address pointed at the local copy. */
async function open(browser: Parameters<Parameters<typeof test>[2]>[0]["browser"], size: (typeof SIZES)[number], theme: (typeof THEMES)[number], tag: string, otherKey?: string): Promise<Run> {
  const token = `e2e-key-${tag}-0123456789`;
  const fake = front.reset(token, otherKey === undefined ? undefined : [otherKey]);
  copy = await startCopy(await claimFor(ACCOUNT_ID, NAME), front.origin);
  const here = copy;
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    isMobile: size.phone,
    hasTouch: size.phone,
    // The page starts light unless a choice stored on the device says dark. So the light runs sit on a
    // device set to dark with nothing stored (the device alone must not darken it), and the dark runs
    // sit on a device set to light with the choice stored.
    colorScheme: theme === "light" ? "dark" : "light",
    reducedMotion: "reduce",
  });
  if (theme === "dark") await context.addInitScript(() => window.localStorage.setItem("vemi:appearance:v1", JSON.stringify({ theme: "dark" })));
  const page = await context.newPage();
  const claims: string[] = [];
  const seen: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A refused key and an app that is not there yet come back from the relay as Cloudflare's own
  // 401 and 404, which the browser logs as it logs any such answer. Anything else failing is a fault.
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  page.on("response", (response) => {
    const u = new URL(response.url());
    if (response.status() >= 400 && u.pathname !== "/get/relay") errors.push(`${response.status()} ${u.origin}${u.pathname}`);
  });
  page.on("request", (req) => { const u = new URL(req.url()); seen.push(`${u.origin}${u.pathname}`); });

  // Cloudflare's own pages are not opened; a tab to one gets a blank answer.
  await context.route("https://dash.cloudflare.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Cloudflare</title>" }));
  // The new copy's address is the local copy: the same Worker, the same /setup/claim.
  await context.route(/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === "POST") claims.push(req.postData() ?? "");
    const response = await route.fetch({ url: `${here.origin}${u.pathname}${u.search}` });
    await route.fulfill({ response });
  });
  return { page, fake, token, claims, seen, errors };
}

const noSideways = async (page: Page, what: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
};

/** What every screen holds to: one h1, a name on every control, no sideways scroll, a picture of it. */
async function screen(run: Run, what: string, shot: string): Promise<void> {
  const { page } = run;
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h2")).toHaveCount(0);
  await darkSide(page, what);
  for (const control of await page.locator("a, button").all()) {
    const name = ((await control.getAttribute("aria-label")) ?? (await control.innerText())).trim();
    const labelled = (await control.getAttribute("aria-labelledby")) !== null;
    expect(name !== "" || labelled, `${what}: a link or button without a name`).toBe(true);
  }
  await noSideways(page, what);
  const text = await page.locator("body").innerText();
  expect(text.includes(String.fromCharCode(0x2014)), `${what} has an em-dash`).toBe(false);
  await page.screenshot({ path: join(SHOTS, `get-${shot}.png`), fullPage: true });
}

const heading = (page: Page, text: string) => expect(page.getByRole("heading", { level: 1, name: text })).toBeVisible();

/** The dark side panel: there, with its headline, and dark whichever theme the page is in. */
async function darkSide(page: Page, what: string): Promise<void> {
  await expect(page.locator(".get-headline"), `${what}: the side's headline`).toBeVisible();
  const [r, g, b] = await page.locator(".get-side").evaluate((el) => (getComputedStyle(el).backgroundColor.match(/\d+/g) ?? []).slice(0, 3).map(Number));
  expect(((r ?? 255) + (g ?? 255) + (b ?? 255)) / 3, `${what}: the side panel is dark`).toBeLessThan(40);
}

/** The small i opens its note on a click, and Escape closes it again. */
async function noteOpensAndCloses(page: Page, label: string): Promise<void> {
  const button = page.getByRole("button", { name: label });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const note = await page.locator("[role=note]:visible").boundingBox();
  const wide = page.viewportSize()?.width ?? 0;
  expect(note !== null && note.x >= 0 && note.x + note.width <= wide, `${label}: the note sits inside the screen`).toBe(true);
  await noSideways(page, label);
  await expect(page.locator("[role=note]:visible")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[role=note]:visible")).toHaveCount(0);
}

/** Steps 1 and 2: the key is pasted and checked. */
async function throughKey(run: Run, shot: string, makeAccount = false): Promise<void> {
  const { page } = run;
  await heading(page, "Cloudflare account");
  await screen(run, "step 1", `${shot}-1`);
  if (makeAccount) {
    const link = page.getByRole("link", { name: "Make a free Cloudflare account" });
    await expect(link).toHaveAttribute("href", SIGN_UP_LINK);
    await expect(link).toHaveAttribute("target", "_blank");
    const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
    await popup.close();
  }
  await page.getByRole("button", { name: "I have one" }).click();

  await heading(page, "Connect Cloudflare");
  await expect(page.getByRole("link", { name: "Open the permission page" })).toHaveAttribute("href", tokenLink());
  await noteOpensAndCloses(page, "Where to find the key");
  await page.getByLabel("Your key").fill("not-a-whole key");
  await expect(page.getByText("That does not look like a whole key.")).toBeVisible();
  await page.getByLabel("Your key").fill(`${run.token}x`);
  await expect(page.getByText("the key was refused", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Next/ })).toBeDisabled();
  await screen(run, "step 2 with a refused key", `${shot}-2-bad`);
  await page.getByLabel("Your key").fill(run.token);
  await expect(page.getByText(`Connected to ${ACCOUNT}`)).toBeVisible();
  await screen(run, "step 2", `${shot}-2`);
  await page.getByRole("button", { name: /^Next/ }).click();
}

/** Step 3: the name is checked and the address shown. */
async function throughName(run: Run, shot: string): Promise<void> {
  const { page } = run;
  await heading(page, "Name your copy");
  await noteOpensAndCloses(page, "About the name");
  await expect(page.getByText(`vemi.${SUBDOMAIN}.workers.dev`)).toBeVisible();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(NAME);
  await expect(page.getByText(`${NAME}.${SUBDOMAIN}.workers.dev`)).toBeVisible();
  await screen(run, "step 3", `${shot}-3`);
  await page.getByRole("button", { name: /^Build my VEMI/ }).click();
}

const SIX = ["Making your database", "Setting up the layout", "Getting the app files ready", "Uploading the app", "Starting the reminder clock", "Giving it an address"];

async function builtSix(run: Run): Promise<void> {
  const { page } = run;
  await expect(page.getByRole("heading", { level: 1, name: "Built" })).toBeVisible({ timeout: 60_000 });
  for (const label of SIX) await expect(page.locator("li.get-row.ok", { hasText: label })).toBeVisible();
}

/** Steps 4 to Done, with the switch as given. */
async function throughFinish(run: Run, shot: string, keep: boolean): Promise<void> {
  const { page } = run;
  await screen(run, "step 4 built", `${shot}-4`);
  await page.getByRole("button", { name: /^Next/ }).click();
  await heading(page, "Keep it up to date");
  await noteOpensAndCloses(page, "About the switch");
  const toggle = page.getByRole("switch", { name: "Let my copy update itself" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  if (!keep) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(keep));
  await screen(run, "step 5", `${shot}-5`);
  expect(await claimable(copy as Copy), "the copy takes no owner before the hand-over").toBe(false);
  await page.getByRole("button", { name: /^Finish/ }).click();
  await heading(page, "Your VEMI is ready");
  await expect(page.getByRole("link", { name: /^Open my VEMI/ })).toHaveAttribute("href", ADDRESS);
  if (keep) await noteOpensAndCloses(page, "About updates");
  await screen(run, "done", `${shot}-done`);
}

/** What was posted to the copy, what the page asked of the app's own routes, and what it kept. */
async function afterwards(run: Run, keep: boolean): Promise<void> {
  const { page, claims, seen, errors, token } = run;
  const here = copy as Copy;
  expect(claims).toHaveLength(1);
  const posted = JSON.parse(claims[0] ?? "{}") as Record<string, unknown>;
  expect(posted["code"]).toBe(await claimFor(ACCOUNT_ID, NAME));
  expect(posted["keepUpdated"]).toBe(keep);
  if (keep) expect(posted["token"]).toBe(token);
  else expect(Object.keys(posted)).not.toContain("token");

  // The hand-over opened the door: the first sign-up on the copy now makes the owner.
  expect(await claimable(here)).toBe(true);
  const made = await here.api.post(`${here.origin}/auth/claim`, { data: { email: "owner@example.test", password: PASSWORD }, headers: { origin: here.origin } });
  expect(made.status()).toBe(200);

  // Nothing of the key or the code is kept in the browser.
  const kept = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage }, cookie: document.cookie, url: location.href }));
  expect(kept).not.toContain(token);
  expect(kept).not.toContain(await claimFor(ACCOUNT_ID, NAME));

  // The page called Cloudflare only through the relay, the new copy only at /setup/claim, and no route of the app.
  const front = new URL(page.url()).origin;
  for (const call of seen) {
    const u = new URL(call);
    if (u.origin === front) expect(call, call).toMatch(/\/(get\/?|get\/relay(\/start)?|assets\/[^/]+|icons\/[^/]+\/[^/]+|icon\.svg|release\/.+)$/);
    else if (u.hostname.endsWith(".workers.dev")) expect(u.pathname).toBe("/setup/claim");
    else expect(call, call).toMatch(/^(data|blob):|dash\.cloudflare\.com/);
  }
  expect(seen.filter((c) => c.includes("api.cloudflare.com"))).toEqual([]);
  expect(run.fake.log.join("\n")).not.toContain(token);
  expect(errors).toEqual([]);
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`the whole flow, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      test.setTimeout(240_000);
      const shot = `${theme}-${size.name}`;
      const run = await open(browser, size, theme, shot);
      const { page } = run;
      await page.goto(`${front.origin}/get/`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("lang", /^[a-z]{2}/);

      await throughKey(run, shot, size.name === "desk" && theme === "light");
      await throughName(run, shot);
      await builtSix(run);
      await throughFinish(run, shot, true);
      await afterwards(run, true);
      await page.context().close();
    });
  }
}

test("a failure is shown with Try again and the Deploy button, and Try again finishes the build", async ({ browser }) => {
  test.setTimeout(240_000);
  const run = await open(browser, SIZES[1], "dark", "fail");
  const { page, fake } = run;
  fake.failOnce("worker.upload", 500);
  await page.goto(`${front.origin}/get/`);
  await throughKey(run, "fail");
  await throughName(run, "fail");

  await expect(page.getByText("Something stopped at uploading the app")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("li.get-row.bad", { hasText: "Uploading the app" })).toBeVisible();
  for (const label of SIX.slice(0, 3)) await expect(page.locator("li.get-row.ok", { hasText: label })).toBeVisible();
  await expect(page.getByRole("link", { name: "Use the Deploy button instead" })).toHaveAttribute("href", DEPLOY_LINK);
  await expect(page.getByRole("button", { name: /^Next/ })).toBeDisabled();
  await screen(run, "the problem screen", "fail-problem");

  const made = fake.requests.filter((r) => r.label === "database.create").length;
  await page.getByRole("button", { name: "Try again" }).click();
  await builtSix(run);
  // What was done is not done again.
  expect(fake.requests.filter((r) => r.label === "database.create")).toHaveLength(made);
  await throughFinish(run, "fail", true);
  await afterwards(run, true);
  await page.context().close();
});

test("a reload in the middle of the build asks for the key again and carries on", async ({ browser }) => {
  test.setTimeout(240_000);
  const run = await open(browser, SIZES[0], "light", "reload");
  const { page, fake } = run;
  fake.failOnce("worker.upload", 500);
  await page.goto(`${front.origin}/get/`);
  await throughKey(run, "reload");
  await throughName(run, "reload");
  await expect(page.getByText("Something stopped at uploading the app")).toBeVisible({ timeout: 60_000 });

  // The tab keeps its place and nothing secret.
  const kept = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  const entries = Object.values(JSON.parse(kept) as Record<string, string>).map((v) => JSON.parse(v) as Record<string, unknown>);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ step: "build", name: NAME, address: null });
  expect(Object.keys(entries[0] ?? {}).sort()).toEqual(["address", "at", "name", "step", "v"]);
  expect(kept).not.toContain(run.token);
  expect(kept).not.toContain(await claimFor(ACCOUNT_ID, NAME));
  const made = fake.requests.filter((r) => r.label === "database.create").length;

  await page.reload();
  await heading(page, "Connect Cloudflare");
  await expect(page.getByLabel("Your key")).toHaveValue("");
  await page.getByLabel("Your key").fill(run.token);
  await expect(page.getByText(`Connected to ${ACCOUNT}`)).toBeVisible();
  await page.getByRole("button", { name: /^Next/ }).click();

  // Straight back to the build, which carries on from what is there.
  await builtSix(run);
  expect(fake.requests.filter((r) => r.label === "database.create")).toHaveLength(made);
  await throughFinish(run, "reload", true);
  await afterwards(run, true);
  await page.context().close();
});

test("a reload after the app is uploaded, resumed with a different key, still hands the copy over", async ({ browser }) => {
  test.setTimeout(240_000);
  const other = "e2e-key-second-9876543210";
  const run = await open(browser, SIZES[0], "light", "other-key", other);
  const { page, fake, claims } = run;
  // The app is up with its claim code when the clock step fails, so the resume skips the upload.
  fake.failOnce("schedules.set", 500);
  await page.goto(`${front.origin}/get/`);
  await throughKey(run, "other-key");
  await throughName(run, "other-key");
  await expect(page.getByText("Something stopped at starting the reminder clock")).toBeVisible({ timeout: 60_000 });
  const uploads = fake.requests.filter((r) => r.label === "worker.upload").length;

  await page.reload();
  await heading(page, "Connect Cloudflare");
  await page.getByLabel("Your key").fill(other);
  await expect(page.getByText(`Connected to ${ACCOUNT}`)).toBeVisible();
  await page.getByRole("button", { name: /^Next/ }).click();
  await builtSix(run);
  expect(fake.requests.filter((r) => r.label === "worker.upload")).toHaveLength(uploads);

  await page.getByRole("button", { name: /^Next/ }).click();
  await heading(page, "Keep it up to date");
  await page.getByRole("button", { name: /^Finish/ }).click();
  await heading(page, "Your VEMI is ready");
  expect(claims).toHaveLength(1);
  const posted = JSON.parse(claims[0] ?? "{}") as Record<string, unknown>;
  expect(posted["code"]).toBe(await claimFor(ACCOUNT_ID, NAME));
  expect(posted["token"]).toBe(other);
  expect(await claimable(copy as Copy)).toBe(true);
  await page.context().close();
});

test("with the switch off the key is not handed over and the way to remove it is shown", async ({ browser }) => {
  test.setTimeout(240_000);
  const run = await open(browser, SIZES[0], "dark", "off");
  const { page } = run;
  await page.goto(`${front.origin}/get/`);
  await throughKey(run, "off");
  await throughName(run, "off");
  await builtSix(run);
  await throughFinish(run, "off", false);

  await expect(page.getByText("VEMI could not remove your key. Remove the one named VEMI setup yourself.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open my keys on Cloudflare" })).toHaveAttribute("href", KEY_LIST_LINK);
  await screen(run, "done with the switch off", "off-done");
  await afterwards(run, false);
  await page.context().close();
});

test("a closed tab picks up again within the hour and shows Done for a finished setup", async ({ browser }) => {
  test.setTimeout(240_000);
  const run = await open(browser, SIZES[1], "light", "done");
  const { page } = run;
  await page.goto(`${front.origin}/get/`);
  await throughKey(run, "done");
  await throughName(run, "done");
  await builtSix(run);
  await throughFinish(run, "done", true);
  await page.reload();
  await heading(page, "Your VEMI is ready");
  await expect(page.getByRole("link", { name: /^Open my VEMI/ })).toHaveAttribute("href", ADDRESS);
  await page.context().close();
});
