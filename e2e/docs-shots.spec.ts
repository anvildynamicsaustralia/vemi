import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { stepPlace, type FirstRunStep } from "../src/web/firstRunSteps.js";
import { MAX_BYTES, ROOT, seedExamples, send, startCopy, type Copy } from "./shotCopy.js";

/**
 * The pictures the docs pages show. Runs only with VEMI_SHOTS=1, so `scripts/check.sh` skips it.
 * It starts a fresh copy through shotCopy.ts, fills it with plain example names, and writes
 * light-theme pictures to docs/images. Desk is 1280 by 800; phone is 390 by 844 with touch.
 * Motion is reduced. Each picture is under 300 KB. Every picture is the real Worker.
 */

test.skip(process.env.VEMI_SHOTS !== "1", "set VEMI_SHOTS=1 to make the docs screenshots");

const OUT = join(ROOT, "docs", "images");
/**
 * First run is shown on the Today screen at this step: the reminders card. The seeded copy
 * already has tasks on today, so the app moves a person on from step 5 to here.
 */
const FIRST_RUN_STEP: FirstRunStep = 6;

let copy: Copy;
let ids = { venture: "", project: "" };

test.beforeAll(async () => {
  test.setTimeout(240_000);
  copy = await startCopy();
  ids = await seedExamples(copy);
  await send(copy, "patch", "/api/appearance", { theme: "light" });
  mkdirSync(OUT, { recursive: true });
});

test.afterAll(async () => {
  await copy?.stop();
});

const DESK = { width: 1280, height: 800, phone: false } as const;
const PHONE = { width: 390, height: 844, phone: true } as const;

const todayPath = (): string => {
  expect(stepPlace(FIRST_RUN_STEP)).toBe("today");
  return "/today";
};

interface Shot {
  readonly file: string;
  readonly size: typeof DESK | typeof PHONE;
  readonly path: () => string;
  /** Run before the picture; it must leave the screen showing real data. */
  readonly ready: (page: Page) => Promise<void>;
  readonly before?: () => Promise<void>;
  readonly after?: () => Promise<void>;
}

const seen = (...names: string[]) => async (page: Page): Promise<void> => {
  for (const name of names) await expect(page.getByText(name).first()).toBeVisible();
};

const shots: readonly Shot[] = [
  { file: "map-desk.png", size: DESK, path: () => "/", ready: seen("Garden Studio", "Home") },
  { file: "map-phone.png", size: PHONE, path: () => "/", ready: seen("Garden Studio", "Home") },
  { file: "today-desk.png", size: DESK, path: () => "/today", ready: seen("Photograph the new plants", "Buy paint and brushes") },
  { file: "today-phone.png", size: PHONE, path: () => "/today", ready: seen("Photograph the new plants", "Buy paint and brushes") },
  {
    file: "project-desk.png",
    size: DESK,
    path: () => `/ventures/${ids.venture}/projects/${ids.project}`,
    ready: seen("Spring catalogue", "Order printed samples"),
  },
  {
    file: "search-desk.png",
    size: DESK,
    path: () => "/search",
    ready: async (page) => {
      await page.getByPlaceholder("Search").fill("paint");
      await seen("Buy paint and brushes")(page);
    },
  },
  {
    file: "first-run-phone.png",
    size: PHONE,
    path: todayPath,
    before: async () => { await send(copy, "patch", "/api/first-run", { step: FIRST_RUN_STEP }); },
    after: async () => { await send(copy, "patch", "/api/first-run", { step: null }); },
    ready: async (page) => {
      await expect(page.getByRole("region", { name: "First steps" })).toBeVisible();
    },
  },
  { file: "account-phone.png", size: PHONE, path: () => "/account", ready: seen("Account") },
];

for (const shot of shots) {
  test(`docs screenshot ${shot.file}`, async ({ browser }) => {
    await shot.before?.();
    const context = await browser.newContext({
      baseURL: copy.origin,
      storageState: await copy.api.storageState(),
      viewport: { width: shot.size.width, height: shot.size.height },
      isMobile: shot.size.phone,
      hasTouch: shot.size.phone,
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(shot.path());
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator("#root")).not.toBeEmpty();
      await page.waitForLoadState("networkidle");
      await shot.ready(page);
      await expect(page.getByRole("alert")).toHaveCount(0);
      const file = join(OUT, shot.file);
      await page.screenshot({ path: file });
      expect(errors).toEqual([]);
      expect(statSync(file).size, `${shot.file} is over 300 KB`).toBeLessThan(MAX_BYTES);
    } finally {
      await context.close();
      await shot.after?.();
    }
  });
}
