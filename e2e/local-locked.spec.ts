import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Locked notes and App lock on the built `/try` (VEMI-013, local-mode task 6). The copy has one
 * account and no email, so the key ways bind to a fixed name. The page is served at
 * `http://localhost:<port>` (WebAuthn refuses an IP address) and gets a Chromium virtual
 * authenticator with the PRF extension, so the real key and the real envelopes are used.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "dist", "web");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

let server: Server;
let origin = "";

test.beforeAll(async () => {
  server = createServer((request, response) => {
    let path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    if (path === "/try") {
      response.writeHead(302, { location: "/try/" }).end();
      return;
    }
    if (path.endsWith("/")) path += "index.html";
    const file = join(WEB, normalize(path));
    try {
      if (!file.startsWith(WEB) || !statSync(file).isFile()) throw new Error("no");
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const bar = (page: Page) => page.getByRole("region", { name: "First steps" });

test("on /try, a task note locks with Face ID and App lock can be set", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctapVersion: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
    },
  });

  await page.goto(`${origin}/try/`);
  await expect(bar(page)).toContainText("Step 1 of");
  await page.getByRole("button", { name: /^Study/ }).click();
  await page.getByPlaceholder("Biology").fill("Biology");
  await page.getByRole("button", { name: "Make it" }).click();
  await page.getByPlaceholder("Lab report").fill("Lab report");
  await page.keyboard.press("Enter");
  await page.getByPlaceholder("Read chapter 3 tomorrow").fill("Read chapter 3");
  await page.keyboard.press("Enter");
  await bar(page).locator("button.first-run-action", { hasText: "Put it on today" }).click();
  await expect(page.getByText("Read chapter 3").first()).toBeVisible();
  const card = page.getByRole("region", { name: "Reminders" });
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(bar(page)).toHaveCount(0);

  // A task's note locks outside the Privacy panel: the first lock sets the key up.
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByText("Read chapter 3").first().click();
  const body = page.locator(".detail-body");
  await expect(body).toBeVisible();
  await body.getByRole("button", { name: "write the body" }).click();
  await body.getByRole("textbox").first().fill("the shed key is under the blue pot");
  await body.getByRole("textbox").first().blur();
  const lock = body.getByRole("button", { name: "Lock", exact: true });
  await expect(lock).toBeVisible();
  await lock.click();
  await page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  const key = (await page.locator(".recovery-key-text").innerText()).trim();
  await page.getByLabel("Last group", { exact: true }).fill(key.split("-").pop() ?? "");
  await page.getByRole("dialog", { name: "task" }).getByRole("button", { name: "Done", exact: true }).click();
  await expect(body.locator(".lock-mark")).toBeVisible();

  // With the key set up, App lock is offered in Privacy, which it is not when the copy has no account name.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("navigation", { name: "Account sections" }).getByRole("button", { name: /^Privacy and security( ›)?$/ }).click();
  const appLock = page.getByRole("group", { name: "App lock" });
  await expect(appLock).toBeVisible({ timeout: 30_000 });
  await appLock.getByRole("button", { name: "1 minute", exact: true }).click();
  await expect(appLock.getByRole("button", { name: "1 minute", exact: true })).toHaveAttribute("aria-pressed", "true");

  expect(errors).toEqual([]);
  await context.close();
});
