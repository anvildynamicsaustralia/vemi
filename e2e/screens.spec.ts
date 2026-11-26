import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, request, test, type APIRequestContext, type Browser } from "@playwright/test";

/**
 * Every main screen, at a desk (1280 by 800) and a phone (390 by 844), in the light and the
 * dark theme. Each is checked for the right theme on the page, no script error and no sideways
 * scroll, and a screenshot is written to `e2e/screenshots/` (git-ignored) to look at.
 *
 * The Worker is the real one, run by `wrangler dev` on a local database in a temporary folder.
 * The operator claims the copy through `/auth/claim`, the same way `src/api/worker.test.ts` does.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = ROOT;
const WRANGLER = join(API_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const SHOTS = join(ROOT, "e2e", "screenshots");
const OPERATOR_EMAIL = "operator@example.test";
const PASSWORD = "an e2e operator password";

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
let ids = { venture: "", project: "", task: "" };

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

async function send<T>(method: "post" | "patch", path: string, data: object): Promise<T> {
  const response = await api[method](`${origin}${path}`, { data, headers: { origin } });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  persist = mkdtempSync(join(tmpdir(), "vemi-e2e-"));
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

  // Something on every screen: a space, a project in it, a task in the project.
  const venture = await send<{ id: string }>("post", "/api/ventures", { name: "Studio" });
  const project = await send<{ id: string }>("post", "/api/projects", { ventureId: venture.id, name: "First release" });
  const task = await send<{ id: string }>("post", "/api/tasks", { ventureId: venture.id, projectId: project.id, title: "Block out the chase" });
  ids = { venture: venture.id, project: project.id, task: task.id };
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

const screens = (): readonly { readonly name: string; readonly path: string }[] => [
  { name: "map", path: "/" },
  { name: "today", path: "/today" },
  { name: "add", path: "/add" },
  { name: "search", path: "/search" },
  { name: "archive", path: "/archive" },
  { name: "account", path: "/account" },
  { name: "space-board", path: `/ventures/${ids.venture}/board` },
  { name: "project", path: `/ventures/${ids.venture}/projects/${ids.project}` },
  { name: "task", path: `/ventures/${ids.venture}/tasks/${ids.task}` },
];

async function open(browser: Browser, size: (typeof SIZES)[number]) {
  return browser.newContext({
    baseURL: origin,
    storageState: await api.storageState(),
    viewport: { width: size.width, height: size.height },
    isMobile: size.phone,
    hasTouch: size.phone,
    reducedMotion: "reduce",
  });
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`every main screen, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      await send("patch", "/api/appearance", { theme });
      const context = await open(browser, size);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      for (const screen of screens()) {
        await test.step(screen.name, async () => {
          await page.goto(screen.path);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("#root")).not.toBeEmpty();
          await page.waitForLoadState("networkidle");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(overflow, `${screen.name} scrolls sideways`).toBeLessThanOrEqual(0);
          await page.screenshot({ path: join(SHOTS, `${screen.name}-${theme}-${size.name}.png`) });
        });
      }
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

// A new project from empty to Next step = a task, the way a person would do it on the page.
for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`a new project walked from empty, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      await send("patch", "/api/appearance", { theme });
      const fresh = await send<{ id: string }>("post", "/api/projects", { ventureId: ids.venture, name: `Walk ${theme} ${size.name}` });
      const context = await open(browser, size);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = (name: string) => page.screenshot({ path: join(SHOTS, `project-walk-${name}-${theme}-${size.name}.png`) });
      const noSideways = async (what: string) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
      };
      const next = page.locator(".side-next").first();

      await page.goto(`/ventures/${ids.venture}/projects/${fresh.id}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: /^Brief/ })).toContainText("0 of 4");
      await expect(next).toContainText("Fill in: What is it");
      await noSideways("the empty project");
      await shot("1-empty");

      // The four Brief steps, each written in place; the Next step follows the first empty one.
      const answers = ["A small tool for the studio", "The people who plan shoots", "Every shot has a task", "Who signs off"];
      for (const [i, answer] of answers.entries()) {
        const step = page.locator(".bstep").nth(i);
        await step.locator("button.bstep-v").click();
        await step.locator("textarea").fill(answer);
        await step.locator("textarea").press("Control+Enter");
        await expect(step.locator("button.bstep-v")).toHaveText(answer);
      }
      await expect(page.getByRole("heading", { name: /^Brief/ })).toContainText("4 of 4");
      await expect(next).toContainText("Add your first milestone");
      await noSideways("the filled Brief");
      await shot("2-brief");

      // A milestone, then a task under it.
      const pm = page.locator(".pm");
      await pm.getByRole("textbox", { name: "a milestone" }).fill("Alpha");
      await pm.getByRole("button", { name: "+ Milestone" }).click();
      await expect(pm.getByRole("tab", { name: /Alpha/ })).toBeVisible();
      await expect(next).toContainText("Add a task to Alpha");
      await pm.getByRole("textbox", { name: "a task" }).fill("Block out the chase");
      await pm.getByRole("button", { name: "Add", exact: true }).click();
      await expect(pm.locator(".pm-task")).toContainText("Block out the chase");
      await expect(next).toContainText("Block out the chase");
      await expect(next.getByRole("button", { name: "Done" })).toBeVisible();
      await noSideways("the first task");
      await shot("3-task");

      // Tick it on its row.
      await pm.getByRole("button", { name: "finish Block out the chase" }).click();
      await expect(pm.getByRole("button", { name: "reopen Block out the chase" })).toHaveAttribute("aria-pressed", "true");

      // A note with bold renders as bold, and the markers are gone.
      const note = page.getByRole("textbox", { name: "a short note" });
      await note.fill("Locked the **final cut** today");
      await page.getByRole("button", { name: "Add note" }).click();
      const entry = page.locator(".notes-entry").first();
      await expect(entry).toContainText("Locked the final cut today");
      await expect(entry).not.toContainText("**");
      await expect(entry.locator("strong").filter({ hasText: "final cut" })).toHaveCount(1);
      await page.waitForLoadState("networkidle");
      await noSideways("the finished walk");
      await shot("4-note");

      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

// Capture: smart dates in Add, a repeating task finished, and the weekly review. The page runs
// in Sydney's zone so the dates it reads are ones the walk can work out for itself.
const ZONE = "Australia/Sydney";

const sydneyToday = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());

const plusDays = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

/** 1 (Monday) to 7 (Sunday). */
const isoDay = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly stateId: string | null;
  readonly dueOn: string | null;
  readonly remindAt: string | null;
  readonly repeat: string | null;
  readonly archivedAt: string | null;
}

async function tasksTitled(prefix: string): Promise<TaskRow[]> {
  const response = await api.get(`${origin}/api/tasks`, { headers: { origin } });
  expect(response.status()).toBe(200);
  const all = (await response.json()) as TaskRow[];
  return all.filter((t) => t.title.startsWith(prefix));
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    const key = `${theme[0]}${size.name}`;
    test(`capture walked, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      await send("patch", "/api/appearance", { theme });
      const context = await browser.newContext({
        baseURL: origin,
        storageState: await api.storageState(),
        viewport: { width: size.width, height: size.height },
        isMobile: size.phone,
        hasTouch: size.phone,
        reducedMotion: "reduce",
        timezoneId: ZONE,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const noSideways = async (what: string) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
      };
      const shot = (name: string) => page.screenshot({ path: join(SHOTS, `capture-${name}-${theme}-${size.name}.png`) });
      const today = sydneyToday();
      const tomorrow = plusDays(today, 1);

      // "call vet tomorrow at 3pm": the date and the time are read out of the title.
      await page.goto("/add");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const title = page.getByRole("textbox", { name: "title" });
      await title.fill(`call vet ${key} tomorrow at 3pm`);
      const read = page.getByRole("group", { name: "read from the title" });
      await expect(read.getByRole("button", { name: "tomorrow" })).toBeVisible();
      await expect(read.getByRole("button", { name: "at 3pm" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add task" })).toBeEnabled();
      await noSideways("Add with its chips");
      await shot("1-add-vet");
      await page.getByRole("button", { name: "Add task" }).click();
      await expect.poll(async () => (await tasksTitled(`call vet ${key}`)).length).toBe(1);
      const [vet] = await tasksTitled(`call vet ${key}`);
      expect(vet).toMatchObject({ title: `call vet ${key}`, dueOn: tomorrow, remindAt: `${tomorrow}T15:00`, repeat: null });

      // "bins every friday": a weekly repeat on Fridays.
      await page.goto("/add");
      await page.getByRole("textbox", { name: "title" }).fill(`bins ${key} every friday`);
      await expect(page.getByRole("group", { name: "read from the title" }).getByRole("button", { name: "every friday" })).toBeVisible();
      await page.getByRole("button", { name: "Add task" }).click();
      await expect.poll(async () => (await tasksTitled(`bins ${key}`)).length).toBe(1);
      const [bins] = await tasksTitled(`bins ${key}`);
      expect(bins?.title).toBe(`bins ${key}`);
      expect(bins?.repeat).toBe("week:5");
      // The words give the repeat and no day; the first date is filed when it is finished.
      expect(bins?.dueOn).toBeNull();

      // A weekly task due today: finishing it makes next week's, and undo takes that back.
      const weekly = `water the plants ${key}`;
      const made = await send<{ id: string }>("post", "/api/tasks", {
        ventureId: ids.venture, title: weekly, dueOn: today, pickedOn: today, repeat: `week:${isoDay(today)}`,
      });
      await page.goto("/today");
      const nextUp = page.getByRole("region", { name: "Next up" });
      await expect(nextUp.getByRole("button", { name: weekly })).toBeVisible();
      await expect(nextUp).toContainText(/Every (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/);
      await noSideways("Today with a weekly task");
      await shot("2-today-weekly");
      await nextUp.getByRole("button", { name: "Done" }).click();
      await expect.poll(async () => (await tasksTitled(weekly)).filter((t) => t.archivedAt === null).length).toBe(2);
      const after = await tasksTitled(weekly);
      const next = after.find((t) => t.id !== made.id);
      expect(next?.dueOn).toBe(plusDays(today, 7));
      expect(next?.repeat).toBe(`week:${isoDay(today)}`);
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await tasksTitled(weekly)).filter((t) => t.archivedAt === null).length).toBe(1);
      const back = (await tasksTitled(weekly)).filter((t) => t.archivedAt === null);
      expect(back[0]?.id).toBe(made.id);
      await noSideways("Today after undo");
      // Put away, so the next walk finds Today as this one did.
      await send("post", `/api/tasks/${made.id}/archive`, {});

      // The weekly review, the three steps and the end.
      await page.goto("/review");
      await expect(page.getByRole("heading", { name: "Weekly review" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
      await noSideways("Review, look back");
      await shot("3-review-back");
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.locator(".review-steps b")).toHaveText("Clear up");
      await noSideways("Review, clear up");
      await shot("4-review-clear");
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.locator(".review-steps b")).toHaveText("Look ahead");
      await noSideways("Review, look ahead");
      await page.getByRole("button", { name: "Review done" }).click();
      await expect(page.getByRole("heading", { name: "Review done" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await noSideways("Review, done");
      await shot("5-review-done");

      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

// Search: grouped results, a built-in filter card, a saved filter, the Archive card, the
// palette and every shortcut, as a person would use them.
for (const theme of THEMES) {
  for (const size of SIZES) {
    const key = `${theme[0]}${size.name}`;
    test(`search, filters, palette and shortcuts walked, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      await send("patch", "/api/appearance", { theme });
      const word = `quokka${key}`;
      await send("post", "/api/tasks", { ventureId: ids.venture, title: `${word} feeding rota` });
      const context = await open(browser, size);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const noSideways = async (what: string) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
      };
      const shot = (name: string) => page.screenshot({ path: join(SHOTS, `search-walk-${name}-${theme}-${size.name}.png`) });

      // A typed search lists grouped results.
      await page.goto("/search");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const field = page.getByRole("textbox", { name: "search" });
      await field.fill(word);
      const tasksGroup = page.getByRole("group", { name: "Tasks", exact: true });
      await expect(tasksGroup.locator(".result-title")).toContainText(`${word} feeding rota`, { timeout: 20_000 });
      await noSideways("Search with results");
      await shot("1-results");

      // Save it as a filter; its card shows once the field is empty.
      await page.getByRole("button", { name: "Save as a filter" }).click();
      const naming = page.getByRole("textbox", { name: "filter name" });
      await naming.fill(`Rota ${key}`);
      await naming.press("Enter");
      await field.fill("");
      const saved = page.locator(".search-card-open", { hasText: `Rota ${key}` });
      await expect(saved).toBeVisible();
      await expect(saved.locator("b")).toHaveText("1");
      await noSideways("Search with filter cards");
      await shot("2-cards");

      // A built-in filter card opens in place.
      await page.locator(".search-card-open", { hasText: "Has a reminder" }).click();
      await expect(page.locator(".search-card-head")).toContainText("Has a reminder");
      await shot("3-builtin");
      await page.locator(".search-card-head").getByRole("button", { name: "Clear" }).click();
      await saved.click();
      await expect(page.locator(".search-card-head")).toContainText(`Rota ${key}`);
      await expect(page.locator(".result-title")).toContainText(`${word} feeding rota`);

      // The Archive card goes to the archive.
      await page.locator(".search-foot").getByRole("button", { name: "Close" }).click();
      await page.goto("/search");
      await page.locator(".search-card-open", { hasText: "Archive" }).click();
      await expect(page).toHaveURL(/\/archive$/);

      // The palette: Ctrl K opens it, a typed word finds an action, Enter runs it.
      await page.goto("/today");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("Control+k");
      const command = page.getByRole("textbox", { name: "command" });
      await expect(command).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      await shot("4-palette");
      await command.fill("weekly");
      await command.press("Enter");
      await expect(page).toHaveURL(/\/review$/);
      await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);

      // Each shortcut, from a page with no field focused.
      await page.goto(`/ventures/${ids.venture}/board`);
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("p");
      await expect(page).toHaveURL(new RegExp(`/ventures/${ids.venture}/projects$`));
      await page.keyboard.press("n");
      await expect(page).toHaveURL(/\/add$/);
      await page.goto("/today");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("/");
      await expect(page).toHaveURL(/\/search$/);
      await page.goto("/today");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("g");
      await page.keyboard.press("m");
      await expect(page).toHaveURL(new RegExp(`^${origin}/$`));
      await page.keyboard.press("g");
      await page.keyboard.press("t");
      await expect(page).toHaveURL(/\/today$/);
      await page.keyboard.press("g");
      await page.keyboard.press("s");
      await expect(page).toHaveURL(/\/search$/);

      // The sheet: ? opens it, a single key does nothing under it, Esc closes it.
      await page.goto("/today");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("?");
      const sheet = page.getByRole("dialog", { name: "Shortcuts" });
      await expect(sheet).toBeVisible();
      await noSideways("the shortcuts sheet");
      await shot("5-shortcuts");
      await page.keyboard.press("n");
      await expect(page).toHaveURL(/\/today$/);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);

      expect(errors).toEqual([]);
      await context.close();
    });
  }
}
