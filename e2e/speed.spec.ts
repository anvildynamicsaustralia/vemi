import { expect, devices, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { isoDay, send, startCopy, type Copy } from "./shotCopy.js";

/**
 * Map and Today under a second on a mid-range phone (VEMI-013 proof, task 2, ruling P2).
 * Runs only with VEMI_SPEED=1, so `scripts/check.sh` skips it. It starts a real copy on the built
 * client (run `pnpm run build` first) with seeded data, opens a phone profile with touch and
 * reduced motion, slows the CPU 4x and the network to DevTools "Fast 4G" through CDP, and times
 * each screen from navigation start to the moment its main content is drawn and filled in.
 * Both a first visit (empty cache, no service worker) and a return visit (worker installed) are
 * measured five times; the median and the worst of each must be under the budget.
 */

test.skip(process.env.VEMI_SPEED !== "1", "set VEMI_SPEED=1 to measure speed");

/** The phone: Playwright's own descriptor, named in the notes. */
export const PHONE_NAME = "Pixel 5";
/** Four times slower than this computer: the DevTools "4x slowdown" CPU setting. */
export const CPU_SLOWDOWN = 4;
/**
 * DevTools "Fast 4G" preset, from devtools-frontend `front_end/core/sdk/NetworkManager.ts`,
 * `Fast4GConditions`: `download: 9 * 1000 * 1000 / 8 * .9` (9 Mbps), `upload: 1.5 * 1000 * 1000 / 8 * .9`
 * (1.5 Mbps), `latency: 60 * 2.75` (60 ms target RTT times the DevTools 2.75 factor).
 */
export const FAST_4G = {
  offline: false,
  downloadThroughput: (9 * 1000 * 1000 / 8) * 0.9,
  uploadThroughput: (1.5 * 1000 * 1000 / 8) * 0.9,
  latency: 60 * 2.75,
} as const;
export const BUDGET_MS = 1000;
export const RUNS = 5;

/** The main content of each screen: Map's first space plate with a project row; Today's Next up card or the cleared day. */
const READY = {
  map: ".map-section .plate-card .plate-project",
  today: 'section.next-up[aria-label="Next up"], .clear .clear-title',
} as const;
type Screen = keyof typeof READY;
const PATH: Record<Screen, string> = { map: "/", today: "/today" };

/** Records, from navigation start, the first frame drawn after the selector matches. */
const timer = (selector: string): string => `(() => {
  const sel = ${JSON.stringify(selector)};
  const poll = () => {
    if (window.__ready !== undefined) return;
    if (document.querySelector(sel)) {
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = performance.now(); }));
      return;
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
})();`;

let copy: Copy;
let cookies: Awaited<ReturnType<Copy["api"]["storageState"]>>;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  copy = await startCopy();
  // A few spaces, projects, 40 tasks and a few on today.
  const spaces: string[] = [];
  for (const name of ["Garden Studio", "Home", "Writing", "Money"]) {
    spaces.push((await send<{ id: string }>(copy, "post", "/api/ventures", { name })).id);
  }
  const projects: { id: string; space: string }[] = [];
  for (const [i, space] of spaces.entries()) {
    for (const n of [1, 2, 3]) {
      const p = await send<{ id: string }>(copy, "post", "/api/projects", { ventureId: space, name: `Project ${i + 1}.${n}` });
      projects.push({ id: p.id, space });
    }
  }
  for (let i = 0; i < 40; i++) {
    const project = projects[i % projects.length]!;
    const today = i < 4;
    await send(copy, "post", "/api/tasks", {
      ventureId: project.space,
      projectId: project.id,
      title: `Task ${i + 1}`,
      ...(today ? { dueOn: isoDay(0), pickedOn: isoDay(0) } : i % 5 === 0 ? { dueOn: isoDay(i % 7 + 1) } : {}),
    });
  }
  cookies = await copy.api.storageState();
});

test.afterAll(async () => {
  await copy?.stop();
});

async function throttle(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", FAST_4G);
  return cdp;
}

async function measure(context: BrowserContext, screen: Screen): Promise<number> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await throttle(page);
  await page.addInitScript(timer(READY[screen]));
  await page.goto(`${copy.origin}${PATH[screen]}`, { waitUntil: "commit" });
  await page.waitForFunction(() => (window as unknown as { __ready?: number }).__ready !== undefined, undefined, { timeout: 30_000 });
  const ms = await page.evaluate(() => (window as unknown as { __ready: number }).__ready);
  expect(errors).toEqual([]);
  if (screen === "map") await expect(page.locator(READY.map).first()).toBeVisible();
  // Let the service worker finish its first install before the page is closed.
  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) await navigator.serviceWorker.ready;
  });
  await page.close();
  return ms;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

for (const screen of ["map", "today"] as const) {
  test(`${screen} draws in under a second, first visit and return visit`, async ({ browser }) => {
    test.setTimeout(240_000);
    const descriptor = devices[PHONE_NAME];
    expect(descriptor, `Playwright has no device named ${PHONE_NAME}`).toBeDefined();
    const first: number[] = [];
    const back: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const context = await browser.newContext({ ...descriptor, reducedMotion: "reduce", hasTouch: true, storageState: cookies });
      first.push(await measure(context, screen));
      // The first visit has put the worker in place; wait until it controls the origin.
      const warm = await context.newPage();
      await warm.goto(`${copy.origin}${PATH[screen]}`);
      await warm.evaluate(async () => { await navigator.serviceWorker.ready; });
      await warm.close();
      back.push(await measure(context, screen));
      await context.close();
    }
    const line = (label: string, xs: readonly number[]) =>
      `${screen} ${label}: ${xs.map((x) => Math.round(x)).join(", ")} ms; median ${Math.round(median(xs))}, worst ${Math.round(Math.max(...xs))}`;
    console.log(`SPEED ${PHONE_NAME} cpu ${CPU_SLOWDOWN}x Fast 4G\n${line("first visit", first)}\n${line("return visit", back)}`);
    for (const xs of [first, back]) {
      expect(median(xs)).toBeLessThan(BUDGET_MS);
      expect(Math.max(...xs)).toBeLessThan(BUDGET_MS);
    }
  });
}
