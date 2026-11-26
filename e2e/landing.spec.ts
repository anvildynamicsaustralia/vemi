import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, request, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { OPERATOR_EMAIL, PASSWORD, ROOT, startServer } from "./copy.js";

/**
 * The signed-out front page in a real browser. At a desk (1280 by 800) and a phone (390 by 844),
 * in both themes, a signed-out visit to `/` shows the page: one `h1`, a name on every link and
 * button, alt text on every image, `lang` on the page, no sideways scroll, no script error.
 * Sign in opens the sign-in card; signed in, `/` stays the start screen; and once the owner
 * turns the page off, `/` goes straight to sign in.
 *
 * Each copy is the real Worker, run by `wrangler dev` on a local database in a temporary folder.
 */

const SHOTS = join(ROOT, "e2e", "screenshots");
const LINE = "Everything you're building, in one place.";

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
  const server = await startServer({ name: "landing" });
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

async function send(copy: Copy, method: "post" | "patch", path: string, data: object): Promise<void> {
  const response = await copy.api[method](`${copy.origin}${path}`, { data, headers: { origin: copy.origin } });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  first = await startCopy();
  await send(first, "post", "/api/ventures", { name: "Studio" });
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await first?.stop();
});

/** A visitor with no session. */
const visitor = async (browser: Browser, copy: Copy, size: (typeof SIZES)[number], theme: (typeof THEMES)[number], kept = theme === "dark") => {
  const context = await browser.newContext({
    baseURL: copy.origin,
    viewport: { width: size.width, height: size.height },
    isMobile: size.phone,
    hasTouch: size.phone,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  // The front page starts light. Dark shows only when this device has a kept choice of dark
  // (the app writes it when the look is chosen), so the dark runs keep one.
  if (kept) {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("vemi:appearance:v1", JSON.stringify({ accent: "ember", spacing: "comfortable", theme: "dark", mapStyle: "grid" }));
      } catch {
        // No storage: the page stays light.
      }
    });
  }
  return context;
};

const noSideways = async (page: Page, what: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
};

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`signed-out / shows the front page, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      const context = await visitor(browser, first, size, theme);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(LINE);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("lang", /^[a-z]{2}/);
      await expect(page.getByText("Made by Anvil Dynamics")).toBeVisible();

      // Every image has words and has loaded; every link and button has a name.
      const images = page.locator(".landing img");
      // The hero's two, the eight in the showcase and the one in the dark block.
      expect(await images.count()).toBe(11);
      for (const img of await images.all()) {
        expect(((await img.getAttribute("alt")) ?? "").trim(), "an image without alt text").not.toBe("");
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
      }
      for (const control of await page.locator("a, button").all()) {
        const name = ((await control.getAttribute("aria-label")) ?? (await control.innerText())).trim();
        expect(name, "a link or button without a name").not.toBe("");
      }
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await noSideways(page, "the front page");
      await page.screenshot({ path: join(SHOTS, `landing-${theme}-${size.name}.png`), fullPage: true });

      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByLabel("Email")).toBeVisible();
      await expect(page.getByLabel("Password")).toBeVisible();
      await expect(page.getByText(LINE)).toHaveCount(0);
      await noSideways(page, "sign in from the front page");
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

test("the showcase tabs change the screen by click and by arrow key", async ({ browser }) => {
  const context = await visitor(browser, first, SIZES[0], "light");
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/");
  const desk = page.getByRole("tablist", { name: "Desktop screens" });
  await desk.scrollIntoViewIfNeeded();
  await expect(desk.getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "true");
  await desk.getByRole("tab", { name: "Project" }).click();
  await expect(desk.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#show-desk-panel img.on")).toHaveAttribute("src", "/landing/desk-project.png");
  await page.keyboard.press("ArrowRight");
  await expect(desk.getByRole("tab", { name: "Search" })).toBeFocused();
  await expect(page.locator("#show-desk-panel img.on")).toHaveAttribute("src", "/landing/desk-search.png");
  await page.keyboard.press("Home");
  await expect(page.locator("#show-desk-panel img.on")).toHaveAttribute("src", "/landing/desk-today.png");
  const phone = page.getByRole("tablist", { name: "Phone screens" });
  await phone.getByRole("tab", { name: "Account" }).click();
  await expect(page.locator("#show-phone-panel img.on")).toHaveAttribute("src", "/landing/phone-account.png");
  expect(errors).toEqual([]);
  await context.close();
});

test("the front page scrolls with the wheel to its footer, at desk and phone size", async ({ browser }) => {
  for (const size of [SIZES[0], SIZES[SIZES.length - 1]]) {
    const context = await visitor(browser, first, size, "light");
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(LINE);
    const scroller = page.locator(".landing");
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.wheel(0, 900);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByText("Made by Anvil Dynamics")).toBeInViewport();
    await context.close();
  }
});

test("a device set to dark with nothing chosen still gets the light front page", async ({ browser }) => {
  const context = await visitor(browser, first, SIZES[0], "dark", false);
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(LINE);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await context.close();
});

test("signed in, / is still the start screen", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: first.origin,
    storageState: await first.api.storageState(),
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.getByText(LINE)).toHaveCount(0);
  await expect(page.getByText("Made by Anvil Dynamics")).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("after the owner turns the front page off, / goes to sign in", async ({ browser }) => {
  const size = SIZES[0];
  const owner = await browser.newContext({
    baseURL: first.origin,
    storageState: await first.api.storageState(),
    viewport: { width: size.width, height: size.height },
    reducedMotion: "reduce",
  });
  const ownerPage = await owner.newPage();
  await ownerPage.goto("/account");
  await ownerPage.getByRole("navigation", { name: "Account sections" }).getByRole("button", { name: /^About/ }).click();
  await ownerPage.getByRole("switch", { name: "Front page" }).click();
  await expect(ownerPage.locator(".notice-text", { hasText: "Front page off." })).toBeVisible();
  await expect.poll(async () => JSON.stringify(await (await first.api.get(`${first.origin}/api/front`)).json())).toContain("false");

  try {
    const context = await visitor(browser, first, size, "light");
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByText(LINE)).toHaveCount(0);
    await expect(page.locator(".landing")).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await send(first, "patch", "/api/front", { landing: true });
    await owner.close();
  }
});
