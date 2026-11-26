import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { build } from "vite";

/**
 * One tab owns the database, and the data stays, in a real browser.
 *
 * The page is a bare harness (`e2e/local-db/`) that runs the leader, the bridge and the channel
 * against the real app in the database worker, built by Vite and served from a small local server
 * on 127.0.0.1 (a secure context, which the private file system needs). At a desk and a phone:
 * a task added is there after a reload; there after the page is closed and a new one opened in the
 * same browser context; and a task made in one of two open pages appears in the other with no
 * reload, including after the owner closes and the other takes over.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [
  { name: "desk", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json",
};

let out = "";
let server: Server;
let origin = "";

test.beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "vemi-local-db-"));
  await build({
    configFile: false,
    root: join(ROOT, "e2e", "local-db"),
    logLevel: "warn",
    resolve: { alias: { "@vemi/shared": join(ROOT, "src", "shared", "index.ts") } },
    build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 },
    worker: { format: "es" },
  });
  server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/"));
    const file = join(out, path === "/" || path === "\\" ? "index.html" : path);
    try {
      if (!file.startsWith(out) || !statSync(file).isFile()) throw new Error("no");
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(out, { recursive: true, force: true });
});

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(origin);
  await expect(page.locator("body[data-ready=yes]")).toHaveCount(1);
  return page;
}

async function add(page: Page, title: string): Promise<void> {
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("a task stays through a reload and through closing the page", async ({ context }) => {
      const first = await open(context);
      await expect(first.locator("#state")).toHaveText("owner kept");
      await add(first, "Check the bore pump");
      await expect(first.getByText("Check the bore pump")).toBeVisible();

      await first.reload();
      await expect(first.getByText("Check the bore pump")).toBeVisible();

      await first.close();
      const second = await open(context);
      await expect(second.getByText("Check the bore pump")).toBeVisible();
      await second.close();
    });

    test("a task made in one page appears in the other with no reload", async ({ context }) => {
      const owner = await open(context);
      const other = await open(context);
      await expect(owner.locator("#state")).toHaveText("owner kept");
      await expect(other.locator("#state")).not.toHaveText("owner kept");

      await add(other, "Made in the second page");
      await expect(owner.getByText("Made in the second page")).toBeVisible();

      await add(owner, "Made in the first page");
      await expect(other.getByText("Made in the first page")).toBeVisible();

      // The owner closes; the other opens the same database and everything is still there.
      await owner.close();
      await expect(other.locator("#state")).toHaveText("owner kept");
      await add(other, "Made after the handover");
      await expect(other.getByText("Made after the handover")).toBeVisible();
      await other.reload();
      for (const title of ["Made in the second page", "Made in the first page", "Made after the handover"]) {
        await expect(other.getByText(title)).toBeVisible();
      }
      await other.close();
    });
  });
}

/**
 * Keeping the data, on the built `/try`. `navigator.storage.persist` is stubbed to say no on one
 * open and yes on the next, in one browser context: the first open's Your data shows the line
 * with Export beside it; the second shows no line.
 */
test.describe("keeping the data", () => {
  const WEB = join(ROOT, "dist", "web");
  const WEB_TYPES: Record<string, string> = {
    ...TYPES, ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
  };
  let site: Server;
  let base = "";

  test.beforeAll(async () => {
    site = createServer((request, response) => {
      let path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      if (path === "/try") {
        response.writeHead(302, { location: "/try/" }).end();
        return;
      }
      if (path.endsWith("/")) path += "index.html";
      const file = join(WEB, normalize(path));
      try {
        if (!file.startsWith(WEB) || !statSync(file).isFile()) throw new Error("no");
        response.writeHead(200, { "content-type": WEB_TYPES[extname(file)] ?? "application/octet-stream" });
        response.end(readFileSync(file));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });

  const LINE = "This browser may clear VEMI's data if you do not use it for a while. Export now and then.";

  async function openYourData(page: Page, answer: boolean): Promise<void> {
    await page.addInitScript((value) => {
      Object.defineProperty(navigator.storage, "persist", { configurable: true, value: async () => value });
    }, answer);
    await page.goto(`${base}/try/`);
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await page.getByRole("navigation", { name: "Account sections" }).getByRole("button", { name: /^Your data/ }).click();
    await expect(page.getByRole("heading", { name: "Your data", exact: true })).toBeVisible();
  }

  test("a browser that will not promise to keep the data says so once, with Export beside it", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const refused = await context.newPage();
    await openYourData(refused, false);
    const note = refused.getByRole("status").filter({ hasText: LINE });
    await expect(note).toBeVisible();
    await expect(note.getByRole("button", { name: "Export", exact: true })).toBeVisible();
    await refused.close();

    const granted = await context.newPage();
    await openYourData(granted, true);
    await expect(granted.getByText("Kept on this device only")).toBeVisible();
    await expect(granted.getByText(LINE)).toHaveCount(0);
    await context.close();
  });

  test("a browser that answers no a second time does not say it again", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const first = await context.newPage();
    await openYourData(first, false);
    await expect(first.getByText(LINE)).toBeVisible();
    await first.close();
    const second = await context.newPage();
    await openYourData(second, false);
    await expect(second.getByText("Kept on this device only")).toBeVisible();
    await expect(second.getByText(LINE)).toHaveCount(0);
    await context.close();
  });
});

/**
 * The same promises on the shipped page: the built `/try`, served as a static host serves it.
 * A task added through the screen stays through a reload and a new page, and a second open page
 * of the same browser context sees a task made in the first with no reload.
 */
test.describe("on the built /try", () => {
  const WEB = join(ROOT, "dist", "web");
  const WEB_TYPES: Record<string, string> = {
    ...TYPES, ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
  };
  let site: Server;
  let base = "";

  test.beforeAll(async () => {
    site = createServer((request, response) => {
      let path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      if (path === "/try") {
        response.writeHead(302, { location: "/try/" }).end();
        return;
      }
      if (path.endsWith("/")) path += "index.html";
      const file = join(WEB, normalize(path));
      try {
        if (!file.startsWith(WEB) || !statSync(file).isFile()) throw new Error("no");
        response.writeHead(200, { "content-type": WEB_TYPES[extname(file)] ?? "application/octet-stream" });
        response.end(readFileSync(file));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });

  const bar = (page: Page) => page.getByRole("region", { name: "First steps" });

  async function firstRun(page: Page): Promise<void> {
    await page.goto(`${base}/try/`);
    await expect(bar(page)).toContainText("Step 1 of");
    await page.getByRole("button", { name: /^Study/ }).click();
    await page.getByPlaceholder("Biology").fill("Biology");
    await page.getByRole("button", { name: "Make it" }).click();
    await page.getByPlaceholder("Lab report").fill("Lab report");
    await page.keyboard.press("Enter");
    await page.getByPlaceholder("Read chapter 3 tomorrow").fill("Read chapter 3 tomorrow at 10am");
    await page.keyboard.press("Enter");
    await bar(page).locator("button.first-run-action", { hasText: "Put it on today" }).click();
    await expect(page.getByText("Read chapter 3").first()).toBeVisible();
  }

  async function projectPage(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Map", exact: true }).first().click();
    await page.getByRole("button", { name: /^Lab report/ }).first().click();
  }

  for (const size of SIZES) {
    test(`a task stays through a reload and a new page, and shows in a second page, ${size.name}`, async ({ browser }) => {
      test.setTimeout(180_000);
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, reducedMotion: "reduce" });
      const first = await context.newPage();
      await firstRun(first);
      await first.reload();
      await expect(first.getByText("Read chapter 3").first()).toBeVisible();

      // A second page of the same browser context holds the same data, and a task made in it
      // reaches the first page with no reload.
      const second = await context.newPage();
      await second.goto(`${base}/try/`);
      await expect(second.getByText("Read chapter 3").first()).toBeVisible();
      await projectPage(first);
      await projectPage(second);
      await second.locator(".pm").getByRole("textbox", { name: /^a task$/i }).fill("Made in the second page");
      await second.locator(".pm").getByRole("button", { name: "Add", exact: true }).click();
      await expect(first.locator(".pm-task").filter({ hasText: "Made in the second page" })).toBeVisible();

      // Closed and opened again: still there.
      await first.close();
      await second.close();
      const third = await context.newPage();
      await third.goto(`${base}/try/`);
      await projectPage(third);
      await expect(third.locator(".pm-task").filter({ hasText: "Made in the second page" })).toBeVisible();
      await context.close();
    });
  }
});
