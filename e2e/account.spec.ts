import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, request, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { OPERATOR_EMAIL, PASSWORD, ROOT, startServer } from "./copy.js";

/**
 * The Account screen in a real browser. Every section is opened at a desk (1280 by 800) and a
 * phone (390 by 844), in both themes, with no script error and no sideways scroll. The four
 * levels are renamed and Map, Today, a project, Search and the palette are scanned for the
 * default words. An export is restored into a second, fresh copy.
 *
 * Each copy is the real Worker, run by `wrangler dev` on a local database in a temporary folder.
 */

const SHOTS = join(ROOT, "e2e", "screenshots");

const SIZES = [
  { name: "desk", width: 1280, height: 800, phone: false },
  { name: "phone", width: 390, height: 844, phone: true },
] as const;
const THEMES = ["light", "dark"] as const;

interface Copy {
  readonly origin: string;
  readonly api: APIRequestContext;
  readonly stop: () => Promise<void>;
}

async function startCopy(): Promise<Copy> {
  const server = await startServer({ name: "account" });
  const origin = server.origin;
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
      await server.stop();
    },
  };
}

let first: Copy;
let ids = { venture: "", project: "", task: "" };

async function send<T>(copy: Copy, method: "post" | "patch", path: string, data: object): Promise<T> {
  const response = await copy.api[method](`${copy.origin}${path}`, { data, headers: { origin: copy.origin } });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  first = await startCopy();
  const venture = await send<{ id: string }>(first, "post", "/api/ventures", { name: "Studio" });
  const project = await send<{ id: string }>(first, "post", "/api/projects", { ventureId: venture.id, name: "First release" });
  const task = await send<{ id: string }>(first, "post", "/api/tasks", { ventureId: venture.id, projectId: project.id, title: "Block out the chase" });
  ids = { venture: venture.id, project: project.id, task: task.id };
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await first?.stop();
});

async function open(browser: Browser, copy: Copy, size: (typeof SIZES)[number]) {
  return browser.newContext({
    baseURL: copy.origin,
    storageState: await copy.api.storageState(),
    viewport: { width: size.width, height: size.height },
    isMobile: size.phone,
    hasTouch: size.phone,
    reducedMotion: "reduce",
  });
}

const noSideways = async (page: Page, what: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
};

const nav = (page: Page) => page.getByRole("navigation", { name: "Account sections" });
/** A section entry; on a phone the list draws a chevron after the title. */
const entry = (page: Page, title: string) => nav(page).getByRole("button", { name: new RegExp(`^${title}( ›)?$`) });

// The owner sees ten sections, Privacy and security among them.
const SECTION_TITLES = [
  "Profile and sign-in", "Names", "Reminders", "Look and feel", "Extras", "AI", "Privacy and security", "People", "Your data", "About",
] as const;

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`every Account section opens, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      await send(first, "patch", "/api/appearance", { theme });
      const context = await open(browser, first, size);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      await page.goto("/account");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const title of SECTION_TITLES) {
        await test.step(title, async () => {
          // On a phone the list is the first thing shown; Back returns to it.
          await entry(page, title).click();
          await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
          await page.waitForLoadState("networkidle");
          await noSideways(page, `Account, ${title}`);
          await page.screenshot({ path: join(SHOTS, `account-${title.toLowerCase().replace(/[^a-z]+/g, "-")}-${theme}-${size.name}.png`) });
          if (size.phone) await page.locator(".back-link", { hasText: "Account" }).first().click();
        });
      }
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

// What a screen says when a level has a new name. Matched as whole words, so a word inside a
// longer one (a "workspace") does not count.
const DEFAULT_WORDS = /\b(spaces?|projects?|milestones?|tasks?)\b/i;

const scan = async (page: Page, what: string): Promise<void> => {
  const text = await page.locator("body").innerText();
  const found = text.match(DEFAULT_WORDS);
  expect(found?.[0] ?? null, `${what} shows a default level word: ${await page.evaluate(() => localStorage.getItem("vemi:levelNames:v1"))}`).toBeNull();
};

for (const size of SIZES) {
  test(`renaming the four levels reaches every screen, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
    await send(first, "patch", "/api/appearance", { theme: "light" });
    const context = await open(browser, first, size);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const names = { "Top level": "Realm", "Inside it": "Quest", "Checkpoints": "Stage", "Things to do": "Chore" } as const;

    await page.goto("/account");
    await entry(page, "Names").click();
    for (const [label, word] of Object.entries(names)) {
      const field = page.getByRole("textbox", { name: label, exact: true });
      await field.fill(word);
      await field.press("Enter");
      await expect(field).toHaveValue(word);
    }
    // The account keeps them: read back from the Worker before the screens are scanned.
    await expect.poll(async () => {
      const read = await first.api.get(`${first.origin}/api/appearance`);
      return JSON.stringify(await read.json());
    }).toContain("Chore");
    await noSideways(page, "Names");

    const palette = async (): Promise<void> => {
      await page.goto("/today");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      await scan(page, "the palette");
      await page.keyboard.press("Escape");
    };

    const screens: readonly (readonly [string, string])[] = [
      ["Map", "/"],
      ["Today", "/today"],
      ["a project", `/ventures/${ids.venture}/projects/${ids.project}`],
      ["Search", "/search"],
    ];
    for (const [what, path] of screens) {
      await test.step(what, async () => {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expect(page.locator("#root")).not.toBeEmpty();
        await scan(page, what);
        await page.screenshot({ path: join(SHOTS, `account-renamed-${what.replace(/\W+/g, "-")}-${size.name}.png`) });
      });
    }
    await test.step("the palette", palette);
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("an export restores into a fresh account", async ({ browser }) => {
  test.setTimeout(240_000);
  const size = SIZES[0];
  const exported = await first.api.get(`${first.origin}/api/export`);
  expect(exported.status()).toBe(200);
  const body = await exported.text();
  const treeOf = async (copy: Copy): Promise<string> => {
    const names = (await (await copy.api.get(`${copy.origin}/api/tree`)).json()) as unknown;
    return JSON.stringify(names, (key, value: unknown) => (["id", "ventureId", "projectId", "createdAt", "updatedAt"].includes(key) ? undefined : value));
  };
  const before = await treeOf(first);
  expect(before).toContain("Block out the chase");

  const fresh = await startCopy();
  try {
    // A copy with no space asks for one first; make it, so the Account screen is reachable.
    await send(fresh, "post", "/api/ventures", { name: "Empty" });
    expect(await treeOf(fresh)).not.toContain("Block out the chase");
    const context = await open(browser, fresh, size);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/account");
    await entry(page, "Your data").click();
    await page.getByLabel("Export file").setInputFiles({ name: "vemi-export.json", mimeType: "application/json", buffer: Buffer.from(body) });
    await expect(page.getByText("vemi-export.json holds")).toBeVisible();
    await page.getByRole("textbox", { name: "Type replace to restore" }).fill("replace");
    await page.getByRole("button", { name: "Replace everything" }).click();
    await expect.poll(() => treeOf(fresh), { timeout: 30_000 }).toBe(before);
    await page.waitForLoadState("networkidle");
    await noSideways(page, "Your data after a restore");
    await page.screenshot({ path: join(SHOTS, "account-restored-desk.png") });
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await fresh.stop();
  }
});
