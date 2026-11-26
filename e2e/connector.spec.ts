import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, request, test, type APIRequestContext, type Browser } from "@playwright/test";

/**
 * Account > AI at a desk and a phone, in both themes: the address with Copy, the two settings
 * links, and no instruction sentence or help button. And the consent page, signed in: Allow and Deny each send the person back to the app, with the
 * right answer in the address. In both themes, at a desk and on a phone. A request the Worker
 * does not know shows one plain line. Signed out, the page signs in first and stays on the
 * request. The Worker is the real one on a local database, as in `screens.spec.ts`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = ROOT;
const WRANGLER = join(API_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const SHOTS = join(ROOT, "e2e", "screenshots");
const OPERATOR_EMAIL = "operator@example.test";
const PASSWORD = "an e2e operator password";
const APP_BACK = "https://claude.example/cb";

const SIZES = [
  { name: "desk", width: 1280, height: 800, phone: false },
  { name: "phone", width: 390, height: 844, phone: true },
] as const;
const THEMES = ["light", "dark"] as const;

let child: ChildProcess | undefined;
let persist = "";
let origin = "";
let output = "";
let api: APIRequestContext;
let clientId = "";
let access = "";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}\n--- wrangler said ---\n${output.slice(-3000)}`);
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  persist = mkdtempSync(join(tmpdir(), "vemi-e2e-connector-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;

  const envFile = join(persist, "e2e.env");
  writeFileSync(envFile, Object.entries({
    ORIGIN: origin,
    OPERATOR_EMAIL,
    SESSION_SECRET: "e2e-session-secret",
  }).map(([key, value]) => `${key}=${value}`).join("\n"));

  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  execFileSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: API_ROOT, env, stdio: "pipe",
  });
  child = spawn(process.execPath, [
    WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(await freePort()), "--persist-to", persist, "--env-file", envFile,
    "--local-upstream", `127.0.0.1:${port}`, "--show-interactive-dev-session=false",
  ], { cwd: API_ROOT, env });
  child.stdout?.on("data", (d) => { output += String(d); });
  child.stderr?.on("data", (d) => { output += String(d); });
  await waitFor(async () => (await fetch(`${origin}/auth/me`).catch(() => null))?.status === 200, 120_000, "wrangler dev to answer");

  api = await request.newContext();
  const claimed = await api.post(`${origin}/auth/claim`, { data: { email: OPERATOR_EMAIL, password: PASSWORD }, headers: { origin } });
  expect(claimed.status()).toBe(200);
  // A seeded copy is not a new person: first run is over before anything draws.
  const skipped = await api.patch(`${origin}/api/first-run`, { data: { step: null }, headers: { origin } });
  expect(skipped.status()).toBe(200);

  const registered = await api.post(`${origin}/oauth/register`, { data: { client_name: "Claude", redirect_uris: [APP_BACK] } });
  expect(registered.status()).toBe(201);
  clientId = ((await registered.json()) as { client_id: string }).client_id;
  // Account sits behind the first space.
  const venture = await api.post(`${origin}/api/ventures`, { data: { name: "Studio" }, headers: { origin } });
  expect(venture.status()).toBeLessThan(300);
  access = await letAppIn();
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await api?.dispose();
  if (child?.pid !== undefined) {
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
});

/** The real round trip: Allow as the signed-in person, trade the code for tokens, and hold the access token. */
async function letAppIn(): Promise<string> {
  const verifier = b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  const allowed = await api.post(`${origin}/api/connector/consent`, {
    data: { decision: "allow", clientId, redirectUri: APP_BACK, codeChallenge, state: "seed", resource: `${origin}/mcp` },
    headers: { origin },
  });
  expect(allowed.status()).toBe(200);
  const code = new URL(((await allowed.json()) as { redirect: string }).redirect).searchParams.get("code") ?? "";
  const traded = await api.post(`${origin}/oauth/token`, {
    form: { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: APP_BACK, client_id: clientId, resource: `${origin}/mcp` },
  });
  expect(traded.status()).toBe(200);
  return ((await traded.json()) as { access_token: string }).access_token;
}

/** The app adds a task, which leaves one change for the person to see and undo. */
async function appAddsATask(title: string): Promise<void> {
  const called = await api.post(`${origin}/mcp`, {
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_task", arguments: { title, space: "Studio" } } },
    headers: { authorization: `Bearer ${access}` },
  });
  expect(called.status()).toBe(200);
  expect(((await called.json()) as { result?: { isError?: boolean } }).result?.isError).toBeUndefined();
}

const b64url = (bytes: Buffer): string => bytes.toString("base64url");
const challenge = (): string => b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));

function connectPath(id = clientId, uri = APP_BACK): string {
  const q = new URLSearchParams({ client_id: id, redirect_uri: uri, code_challenge: challenge(), state: "st-1", resource: `${origin}/mcp` });
  return `/connect?${q.toString()}`;
}

async function open(browser: Browser, size: (typeof SIZES)[number], signedIn = true) {
  return browser.newContext({
    baseURL: origin,
    storageState: signedIn ? await api.storageState() : undefined,
    viewport: { width: size.width, height: size.height },
    isMobile: size.phone,
    hasTouch: size.phone,
    reducedMotion: "reduce",
  });
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`allow and deny, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      expect((await api.patch(`${origin}/api/appearance`, { data: { theme }, headers: { origin } })).status()).toBeLessThan(300);
      const context = await open(browser, size);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // The app's own address is somewhere else: answer it here so the redirect can be read.
      await page.route("https://claude.example/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>back</p>" }));

      for (const decision of ["allow", "deny"] as const) {
        await page.goto(connectPath());
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByText("Claude wants to read and change your VEMI. It can't delete anything.")).toBeVisible();
        // An app VEMI cannot verify: the note on its return site, then Deny and Allow anyway. No logo.
        await expect(page.getByText("Not verified")).toBeVisible();
        await expect(page.getByRole("img", { name: "Claude" })).toHaveCount(0);
        await expect(page.getByRole("button")).toHaveText(["i", "Deny", "Allow anyway"]);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
        await page.screenshot({ path: join(SHOTS, `connect-${decision}-${theme}-${size.name}.png`) });
        await page.getByRole("button", { name: decision === "allow" ? "Allow anyway" : "Deny" }).click();
        await page.waitForURL(`${APP_BACK}?**`);
        const back = new URL(page.url());
        expect(back.searchParams.get("state")).toBe("st-1");
        if (decision === "allow") {
          expect(back.searchParams.get("code")).not.toBeNull();
          expect(back.searchParams.get("error")).toBeNull();
        } else {
          expect(back.searchParams.get("error")).toBe("access_denied");
          expect(back.searchParams.get("code")).toBeNull();
        }
      }
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

test("an app VEMI does not know shows one plain line and no buttons", async ({ browser }) => {
  const context = await open(browser, SIZES[0]);
  const page = await context.newPage();
  await page.goto(connectPath("c_nobody"));
  await expect(page.getByText("This request is not one VEMI knows.")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await page.goto(connectPath(clientId, "https://evil.example/cb"));
  await expect(page.getByText("This request is not one VEMI knows.")).toBeVisible();
  await context.close();
});

test("signed out, the page signs in first and stays on the request", async ({ browser }) => {
  const context = await open(browser, SIZES[0], false);
  const page = await context.newPage();
  await page.goto(connectPath());
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/connect");
  await page.getByLabel("Email").fill(OPERATOR_EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Claude wants to read and change your VEMI. It can't delete anything.")).toBeVisible();
  await context.close();
});

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`Account AI, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      const set = await api.patch(`${origin}/api/appearance`, { data: { theme }, headers: { origin } });
      expect(set.status()).toBeLessThan(300);
      const context = await browser.newContext({
        baseURL: origin,
        storageState: await api.storageState(),
        viewport: { width: size.width, height: size.height },
        isMobile: size.phone,
        hasTouch: size.phone,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await appAddsATask(`Added by the app, ${theme} ${size.name}`);

      await page.goto("/account");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByRole("navigation", { name: "Account sections" }).getByRole("button", { name: /^AI( ›)?$/ }).click();
      const ai = page.getByTestId("account-ai");
      await expect(ai).toBeVisible();
      await expect(ai.locator(".ai-code")).toHaveText(`${origin}/mcp`);
      await expect(ai.getByRole("button", { name: "Copy" })).toBeVisible();
      await expect(ai.getByRole("link", { name: "Claude" })).toHaveAttribute("href", "https://claude.ai/customize/connectors");
      await expect(ai.getByRole("link", { name: "ChatGPT" })).toHaveAttribute("href", "https://chatgpt.com/plugins");
      await expect(ai.getByRole("button", { name: /help/i })).toHaveCount(0);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "Account scrolls sideways").toBeLessThanOrEqual(0);
      // A grant and a change are seeded, so the rows, Revoke and Undo are really drawn.
      await expect(ai.getByText("Last used")).toBeVisible();
      await expect(ai.getByRole("button", { name: "Revoke" })).toBeVisible();
      await expect(ai.getByText("Claude: add task").first()).toBeVisible();
      await expect(ai.getByRole("button", { name: "Undo" }).first()).toBeVisible();
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(sideways, "Account with rows scrolls sideways").toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `account-ai-${theme}-${size.name}.png` ) });
      await ai.getByRole("button", { name: "Undo" }).first().click();
      await expect(page.getByText("Put back").first()).toBeVisible();
      await expect(ai.getByText(", put back").first()).toBeVisible();
      const afterUndo = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(afterUndo, "the notice scrolls the page sideways").toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `account-ai-undone-${theme}-${size.name}.png` ) });
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}
