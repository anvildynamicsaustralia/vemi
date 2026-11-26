import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Nothing leaves the page at `/try`, watched from outside it.
 *
 * The built files are served as a static host serves them, with the `/try/*` policy from
 * `public/_headers` on every answer under `/try/`, and with no Worker behind them. The spec
 * records every request the page, its database worker and its service worker make, and every
 * socket it opens, while a person does first run, adds a space, a project, a milestone and a task
 * with a smart date and a reminder, and uses Today, Search, the command palette, Archive,
 * Account (every section), an export and a restore. A request passes only when it is a static
 * file of the page's own origin (the page under `/try/`, the built code, styles, fonts and icons
 * it loads) or a `blob:` or `data:` address the app made itself. An `/api`, `/auth`, `/mcp`,
 * `/oauth` path, another host, or a socket fails the run, and so does any policy violation.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "dist", "web");
const SIZES = [
  { name: "desk", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

/** The policy for `/try/*`, read from the headers file the host serves. */
function policy(): string {
  const lines = readFileSync(join(WEB, "_headers"), "utf8").split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() === "/try/*");
  const found = lines.slice(at + 1).map((line) => line.trim()).find((line) => line.startsWith("Content-Security-Policy:"));
  if (at < 0 || found === undefined) throw new Error("dist/web/_headers has no /try/* policy");
  return found.slice("Content-Security-Policy:".length).trim();
}

let server: Server;
let origin = "";
/** Paths the static host answered 404 to; none may be asked for. */
const missing: string[] = [];

test.beforeAll(async () => {
  const csp = policy();
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
      const headers: Record<string, string> = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
      if (path.startsWith("/try/")) headers["content-security-policy"] = csp;
      response.writeHead(200, headers);
      response.end(readFileSync(file));
    } catch {
      missing.push(path);
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Static files of the page's own: its page and files under `/try/`, and the built files it loads. */
const OWN_STATIC = [/^\/try(?:\/|$)/, /^\/assets\//, /^\/icons\//, /^\/icon\.svg$/, /^\/apple-touch-icon\.png$/];
const FORBIDDEN = [/^\/api(?:\/|$)/, /^\/auth(?:\/|$)/, /^\/mcp(?:\/|$)/, /^\/oauth(?:\/|$)/, /^\/\.well-known(?:\/|$)/, /^\/setup(?:\/|$)/];

/** Why a request is not allowed, or null when it is. */
function refusal(url: string, method: string): string | null {
  if (url.startsWith("blob:") || url.startsWith("data:")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not an address";
  }
  if (parsed.origin !== origin) return "another origin";
  if (FORBIDDEN.some((rule) => rule.test(parsed.pathname))) return "a server path";
  if (method !== "GET") return "not a read of a static file";
  if (!OWN_STATIC.some((rule) => rule.test(parsed.pathname))) return "not a file the page owns";
  return null;
}

const bar = (page: Page) => page.getByRole("region", { name: "First steps" });

for (const size of SIZES) {
  test(`first run to export and restore sends nothing, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      isMobile: size.name === "phone",
      hasTouch: size.name === "phone",
      acceptDownloads: true,
      reducedMotion: "reduce",
    });
    const seen: string[] = [];
    const bad: string[] = [];
    const note = (url: string, method: string, from: string): void => {
      seen.push(`${method} ${url}`);
      const why = refusal(url, method);
      if (why !== null) bad.push(`${from}: ${method} ${url} (${why})`);
    };
    // Every request the page, its dedicated worker and its service worker make.
    context.on("request", (request) => note(request.url(), request.method(), request.serviceWorker() === null ? "page" : "service worker"));
    const errors: string[] = [];
    const page = await context.newPage();
    page.on("websocket", (socket) => bad.push(`page: socket ${socket.url()}`));
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/content security policy/i.test(message.text())) bad.push(`policy: ${message.text().slice(0, 200)}`);
    });
    context.on("serviceworker", (worker) => {
      if (!worker.url().startsWith(`${origin}/try/`)) bad.push(`service worker: ${worker.url()} is not the page's own`);
    });
    // The page reports a policy violation as an event; collect them in the page.
    await page.addInitScript(() => {
      (window as unknown as { __violations: string[] }).__violations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    await page.goto(`${origin}/try`);
    await expect(page).toHaveURL(`${origin}/try/`);

    // First run: Study, a space, a project, a task with a smart date and a reminder.
    await expect(bar(page)).toContainText("Step 1 of");
    await page.getByRole("button", { name: /^Study/ }).click();
    await expect(bar(page)).toContainText("Step 2 of");
    await page.getByPlaceholder("Biology").fill("Biology");
    await page.getByRole("button", { name: "Make it" }).click();
    await expect(bar(page)).toContainText("Step 3 of");
    await page.getByPlaceholder("Lab report").fill("Lab report");
    await page.keyboard.press("Enter");
    await expect(bar(page)).toContainText("Step 4 of");
    await page.getByPlaceholder("Read chapter 3 tomorrow").fill("Read chapter 3 tomorrow at 10am");
    await page.keyboard.press("Enter");
    await expect(bar(page)).toContainText("Step 5 of");
    await bar(page).locator("button.first-run-action", { hasText: "Put it on today" }).click();
    await expect(page.getByText("Read chapter 3").first()).toBeVisible();
    const card = page.getByRole("region", { name: "Reminders" });
    await expect(bar(page)).toContainText("Step 6 of");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Not now" }).click();
    await expect(bar(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page.getByRole("button", { name: /^Lab report/ }).first().click();

    // A milestone and a task with a smart date and a reminder, on the project's page.
    const pm = page.locator(".pm");
    await pm.getByRole("textbox", { name: /^a (checkpoint|milestone)$/i }).fill("Midterm");
    await pm.getByRole("button", { name: /^\+ (Checkpoint|Milestone)$/ }).click();
    await expect(pm.getByRole("tab", { name: /Midterm/ })).toBeVisible();
    await pm.getByRole("textbox", { name: /^a task$/i }).fill("Call the lab tomorrow at 9am");
    await pm.getByRole("button", { name: "Add", exact: true }).click();
    await expect(pm.locator(".pm-task").filter({ hasText: "Call the lab" })).toBeVisible();

    // The repo link: the last-push lookup must never run, so the row shows the link alone.
    await page.getByRole("button", { name: /Link a GitHub repo/ }).click();
    await page.getByRole("textbox", { name: "GitHub repo" }).fill("anvildynamicsau/vemi");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("link", { name: "anvildynamicsau/vemi", exact: true })).toBeVisible();
    await expect(page.getByText(/Last push/)).toHaveCount(0);

    // Today, Search and the palette.
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByText("Read chapter 3").first()).toBeVisible();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("searchbox").or(page.getByRole("textbox")).first()).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Archive: a milestone archived from its project, then the Archive screen from Search.
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page.getByRole("button", { name: /^Lab report/ }).first().click();
    await pm.getByRole("button", { name: /^archive (checkpoint|milestone)/ }).click();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.locator(".search-card-open", { hasText: "Archive" }).click();
    await expect(page.getByPlaceholder("Search the archive")).toBeVisible();

    // Account: every section the page shows.
    await page.getByRole("button", { name: "Account", exact: true }).click();
    const sections = page.getByRole("navigation", { name: "Account sections" });
    // Account is fetched when first opened: wait for it before reading what it lists.
    await expect(sections).toBeVisible();
    const titles = (await sections.getByRole("button").allInnerTexts()).map((text) => text.replace(/ ›$/, "").trim());
    expect(titles).toContain("Your data");
    for (const title of titles) {
      await sections.getByRole("button", { name: new RegExp(`^${title}( ›)?$`) }).click();
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      if (size.name === "phone") await page.locator(".back-link", { hasText: "Account" }).first().click();
    }

    // Export, then a restore of that file.
    await sections.getByRole("button", { name: /^Your data/ }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    const saved = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of saved) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    expect(body.toString("utf8")).toContain("Call the lab");
    await page.getByLabel("Export file").setInputFiles({ name: "vemi-export.json", mimeType: "application/json", buffer: body });
    await expect(page.getByText("vemi-export.json holds")).toBeVisible();
    await page.getByRole("textbox", { name: "Type replace to restore" }).fill("replace");
    await page.getByRole("button", { name: "Replace everything" }).click();
    await expect(page.getByRole("textbox", { name: "Type replace to restore" })).toHaveCount(0);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByText("Read chapter 3").first()).toBeVisible();

    const violations = await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
    expect(violations).toEqual([]);
    expect(seen.filter((entry) => entry.includes("api.github.com"))).toEqual([]);
    expect(missing).toEqual([]);
    expect(bad, `seen so far:\n${seen.join("\n")}`).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });
}
