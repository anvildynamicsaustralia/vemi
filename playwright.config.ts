import { defineConfig } from "@playwright/test";

/**
 * VEMI-013 (design). The screens, looked at in a real browser: both themes, a desk and a phone.
 * The spec starts the Worker itself (`wrangler dev` on a throwaway local database, serving the
 * built client from `dist/web`), so nothing here touches Cloudflare. Run the build first;
 * `scripts/check.sh` does. One worker, because every test reads the one database.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  // Every step here waits on a real Worker and a real database. Playwright's own 5 s wait for an
  // assertion is the first thing a busy machine outruns, so a wait is given room to finish. A
  // wrong state still fails: the room is for slow, not for never, and no assertion is changed.
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "e2e/results",
});
