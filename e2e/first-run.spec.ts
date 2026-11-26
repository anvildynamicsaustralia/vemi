import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PASSWORD, ROOT, startServer } from "./copy.js";

/**
 * First run in a real browser, on a fresh copy. At phone size (390 by 844), in both themes, a new
 * owner signs up, gets past the recovery code, picks Study, names a space, adds a project and a
 * task typed with "tomorrow", puts it on Today and answers Not now. A reload partway resumes at
 * the same step, Skip ends first run, an iPhone sees the home screen step, a desk run finishes
 * once, the Map tip shows once afterwards, and Run first steps again starts over.
 *
 * Each copy is the real Worker, run by `wrangler dev` on a local database in a temporary folder.
 */

const SHOTS = join(ROOT, "e2e", "screenshots");
const OWNER_EMAIL = "operator@example.test";
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };
const IPHONE_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const THEMES = ["light", "dark"] as const;
const DEFAULT_WORDS = /\b(Venture|Milestone)s?\b/;

interface Copy {
  readonly origin: string;
  readonly api: APIRequestContext;
  readonly stop: () => Promise<void>;
}

/** A fresh copy: nothing claimed, so the first person to sign up is a new owner in first run. */
async function startCopy(): Promise<Copy> {
  const server = await startServer({ name: "first-run", vars: (origin) => ({ ORIGIN: origin, SESSION_SECRET: "e2e-session-secret" }) });
  const api = await request.newContext();
  return {
    origin: server.origin,
    api,
    stop: async () => {
      await api.dispose();
      await server.stop();
    },
  };
}

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

const noSideways = async (page: Page, what: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
};

const stranger = (
  browser: Browser,
  copy: Copy,
  size: { readonly width: number; readonly height: number },
  theme: (typeof THEMES)[number],
  phone: boolean,
  userAgent?: string,
): Promise<BrowserContext> =>
  browser.newContext({
    baseURL: copy.origin,
    viewport: size,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
    reducedMotion: "reduce",
    ...(userAgent === undefined ? {} : { userAgent }),
  });

/** From a signed-out `/` to the shell: Sign in, Create the owner account, past the recovery code. */
async function signUp(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Create the owner account" }).click();
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Password again").fill(PASSWORD);
  await page.getByRole("button", { name: "Create the owner account" }).click();
  await expect(page.getByText("Recovery code")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
}

const bar = (page: Page) => page.getByRole("region", { name: "First steps" });

/** Steps 1 to 4: Study, a space, a project, a task typed with a date word. */
async function throughFour(page: Page, theme: string, size: string, total = 6): Promise<void> {
  await expect(bar(page)).toContainText(`Step 1 of ${total}`);
  await expect(page.getByRole("heading", { name: "What are you using VEMI for?" })).toBeVisible();
  await page.getByRole("button", { name: /^Study/ }).click();
  await expect(page.locator(".notice-text", { hasText: "Names changed to Study." })).toBeVisible();

  await expect(bar(page)).toContainText(`Step 2 of ${total}`);
  await page.getByPlaceholder("Biology").fill("Biology");
  await page.getByRole("button", { name: "Make it" }).click();

  await expect(bar(page)).toContainText(`Step 3 of ${total}`);
  await page.screenshot({ path: join(SHOTS, `first-run-step3-${theme}-${size}.png`) });
  await page.getByPlaceholder("Lab report").fill("Lab report");
  await page.keyboard.press("Enter");

  await expect(bar(page)).toContainText(`Step 4 of ${total}`);
  const task = page.getByPlaceholder("Read chapter 3 tomorrow");
  await task.fill("Read chapter 3 tomorrow");
  await expect(page.locator(".chip, .smart-chip").filter({ hasText: /tomorrow/i }).first()).toBeVisible();
  await page.keyboard.press("Enter");
}

test.describe.configure({ mode: "serial" });

for (const theme of THEMES) {
  test(`a new owner reaches a task on Today, ${theme}, phone ${PHONE.width} by ${PHONE.height}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const copy = await startCopy();
    try {
      const context = await stranger(browser, copy, PHONE, theme, true);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      await signUp(page);
      await throughFour(page, theme, "phone");

      // Step 5: the one button, then Today with the task on it.
      await expect(bar(page)).toContainText("Step 5 of 6");
      await bar(page).locator("button.first-run-action", { hasText: "Put it on today" }).click();
      await expect(page.getByText("Read chapter 3").first()).toBeVisible();

      // Step 6: the reminder card, answered with Not now.
      await expect(bar(page)).toContainText("Step 6 of 6");
      const card = page.getByRole("region", { name: "Reminders" });
      await expect(card).toBeVisible();
      await noSideways(page, "the reminder card");
      await page.screenshot({ path: join(SHOTS, `first-run-today-${theme}-phone.png`) });
      await card.getByRole("button", { name: "Not now" }).click();

      // First run is over: no bar, the Study words on the map, no default level word anywhere.
      await expect(bar(page)).toHaveCount(0);
      await expect(page.getByText(/^Step \d of \d$/)).toHaveCount(0);
      await page.goto("/");
      await expect(page.getByText("Biology").first()).toBeVisible();
      expect(await page.locator("body").innerText()).not.toMatch(DEFAULT_WORDS);
      await noSideways(page, "the map after first run");
      await page.screenshot({ path: join(SHOTS, `first-run-map-${theme}-phone.png`) });
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await copy.stop();
    }
  });
}

test("a reload at step 3 resumes at step 3, and Skip on step 2 ends first run", async ({ browser }) => {
  test.setTimeout(240_000);
  const copy = await startCopy();
  try {
    const context = await stranger(browser, copy, PHONE, "light", true);
    const page = await context.newPage();
    await signUp(page);
    await expect(bar(page)).toContainText("Step 1 of 6");
    await page.getByRole("button", { name: /^Study/ }).click();
    await page.getByPlaceholder("Biology").fill("Biology");
    await page.getByRole("button", { name: "Make it" }).click();
    await expect(bar(page)).toContainText("Step 3 of 6");

    await page.reload();
    await expect(bar(page)).toContainText("Step 3 of 6");
    await expect(page.getByPlaceholder("Lab report")).toBeVisible();
    await context.close();
  } finally {
    await copy.stop();
  }

  const other = await startCopy();
  try {
    const context = await stranger(browser, other, PHONE, "light", true);
    const page = await context.newPage();
    await signUp(page);
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(bar(page)).toContainText("Step 2 of 6");
    await bar(page).getByRole("button", { name: "Skip" }).click();
    await expect(bar(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(bar(page)).toHaveCount(0);
    await context.close();
  } finally {
    await other.stop();
  }
});

test("an iPhone browser sees step 7 with the Safari steps", async ({ browser }) => {
  test.setTimeout(240_000);
  const copy = await startCopy();
  try {
    const context = await stranger(browser, copy, PHONE, "light", true, IPHONE_AGENT);
    const page = await context.newPage();
    await signUp(page);
    await expect(bar(page)).toContainText("Step 1 of 7");
    await throughFour(page, "light", "iphone", 7);
    await expect(bar(page)).toContainText("Step 5 of 7");
    await bar(page).locator("button.first-run-action", { hasText: "Put it on today" }).click();
    await expect(bar(page)).toContainText("Step 6 of 7");
    await page.getByRole("region", { name: "Reminders" }).getByRole("button", { name: "Not now" }).click();

    await expect(bar(page)).toContainText("Step 7 of 7");
    const home = page.getByRole("region", { name: "Home screen" });
    await expect(home).toContainText("Add VEMI to your home screen");
    await expect(home).toContainText("Share");
    await noSideways(page, "the home screen step");
    await page.screenshot({ path: join(SHOTS, "first-run-step7-iphone.png") });
    await home.getByRole("button", { name: "Not now" }).click();
    await expect(bar(page)).toHaveCount(0);
    await context.close();
  } finally {
    await copy.stop();
  }
});

test("a desk run completes once, the Map tip shows once, and Run first steps again starts over", async ({ browser }) => {
  test.setTimeout(240_000);
  const copy = await startCopy();
  try {
    const context = await stranger(browser, copy, DESK, "light", false);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signUp(page);
    await throughFour(page, "light", "desk");
    await expect(bar(page)).toContainText("Step 5 of 6");
    await bar(page).locator("button.first-run-action", { hasText: "Put it on today" }).click();
    await expect(bar(page)).toContainText("Step 6 of 6");
    await page.getByRole("region", { name: "Reminders" }).getByRole("button", { name: "Not now" }).click();
    await expect(bar(page)).toHaveCount(0);

    // Finished once: a reload does not bring it back, and the Map tip shows now.
    await page.goto("/");
    await expect(bar(page)).toHaveCount(0);
    const tip = page.locator("button.tip");
    await expect(tip).toHaveCount(1);
    await expect(tip).toContainText("Pin assignments to keep them first.");
    await tip.click();
    await expect(tip).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Biology").first()).toBeVisible();
    await expect(page.locator("button.tip")).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);

    // Run first steps again, from Account > About.
    await page.goto("/account");
    await page.getByRole("navigation", { name: "Account sections" }).getByRole("button", { name: /^About/ }).click();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(bar(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "What are you using VEMI for?" })).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await copy.stop();
  }
});
