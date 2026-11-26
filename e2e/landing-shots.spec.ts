import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { MAX_BYTES, ROOT, seedExamples, send, startCopy, type Copy } from "./shotCopy.js";

/**
 * The landing page screenshots. Runs only with VEMI_SHOTS=1, so `scripts/check.sh` skips it.
 * It starts a fresh copy, fills it with plain example names, and writes three pictures to
 * public/landing: the eight screens the front page shows (desk and phone, light, 2x). Each must
 * stay under 300 KB. The search screen needs "paint" typed in by hand; this spec does not.
 *
 * The copy is the real Worker, run by `wrangler dev` on a local database in a temporary folder
 * (see shotCopy.ts).
 */

test.skip(process.env.VEMI_SHOTS !== "1", "set VEMI_SHOTS=1 to make the landing screenshots");

const OUT = join(ROOT, "public", "landing");

let copy: Copy;
let ids = { venture: "", project: "" };

test.beforeAll(async () => {
  test.setTimeout(240_000);
  copy = await startCopy();
  ids = await seedExamples(copy);
  mkdirSync(OUT, { recursive: true });
});

test.afterAll(async () => {
  await copy?.stop();
});

const shots = [
  { file: "desk-map.png", theme: "light", width: 1280, height: 800, phone: false, path: () => "/" },
  { file: "desk-today.png", theme: "light", width: 1280, height: 800, phone: false, path: () => "/today" },
  { file: "desk-project.png", theme: "light", width: 1280, height: 800, phone: false, path: () => `/ventures/${ids.venture}/projects/${ids.project}` },
  { file: "desk-search.png", theme: "light", width: 1280, height: 800, phone: false, path: () => "/search" },
  { file: "phone-map.png", theme: "light", width: 390, height: 844, phone: true, path: () => "/" },
  { file: "phone-today.png", theme: "light", width: 390, height: 844, phone: true, path: () => "/today" },
  { file: "phone-project.png", theme: "light", width: 390, height: 844, phone: true, path: () => `/ventures/${ids.venture}/projects/${ids.project}` },
  { file: "phone-account.png", theme: "light", width: 390, height: 844, phone: true, path: () => "/account" },
] as const;

for (const shot of shots) {
  test(`landing screenshot ${shot.file}`, async ({ browser }) => {
    await send(copy, "patch", "/api/appearance", { theme: shot.theme });
    const context = await browser.newContext({
      baseURL: copy.origin,
      storageState: await copy.api.storageState(),
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: 2,
      isMobile: shot.phone,
      hasTouch: shot.phone,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(shot.path());
    await expect(page.locator("html")).toHaveAttribute("data-theme", shot.theme);
    await expect(page.locator("#root")).not.toBeEmpty();
    await page.waitForLoadState("networkidle");
    const file = join(OUT, shot.file);
    await page.screenshot({ path: file });
    await context.close();
    expect(statSync(file).size, `${shot.file} is over 300 KB`).toBeLessThan(MAX_BYTES);
  });
}
