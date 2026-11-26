import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { isoDay, ROOT, send, startCopy, type Copy } from "./shotCopy.js";

/**
 * The sweep. Every surface in the brief and every route in `src/web/router.ts`, signed in on a
 * copy that is brand new (first run on), on a seeded copy, on a seeded copy with the four level
 * names renamed, and signed out; in light and dark, at a desk (1280 by 800) and a phone (390 by
 * 844). Each page, and each sheet opened over it, is read for what a person would trip on:
 * an em-dash, a control with no name, a Help or Undo or Redo that no change asked for, a mock's
 * example name, a console error or failed request, an old level word after a rename, and a side
 * scroll on a phone. A last pass clicks every visible, non-destructive control on a seeded copy
 * and fails any that changes nothing: no address, no page text, no request, no sheet.
 *
 * The visible sentences that begin with an instruction word go to `e2e/results/sweep.json` for a
 * person to read. That list never fails the test.
 */

const EM_DASH = String.fromCharCode(0x2014);

/** Example names copied from `mocks/*.html`. A person's own seeded data never uses these. */
const MOCK_NAMES: readonly string[] = [
  "Anvil Console", "Roado", "Black Dingo Studios", "Black Dingo Network", "Code Blue",
  "Project R3D", "Project Winter", "FiveM server", "Discord hub", "Shed fit-out", "Vehicle rego",
  "Software Design", "Game prototype", "Unit 3 quiz", "Motion lab report", "Exam revision", "Garden beds",
  "Couch to 5k", "Pick list for the cool room", "Patrol car livery", "Fix Discord role sync",
  "Order shed shelving", "Contact form copy", "Renew vehicle rego", "Discord role audit", "Quiet hours picker",
];

const OLD_WORDS = /\b(spaces?|projects?|milestones?|tasks?|ventures?)\b/i;
const FORBIDDEN_CONTROL = /^(help|how this works|redo|undo)$/i;
const DESTRUCTIVE = /\b(delete|archive|remove|turn off|sign out|replace)\b/i;
const IMPERATIVE = /(?:^|[.!?]\s+|\n)((?:Click|Tap|Press|Use|Choose|Select|Type|Enter|Drag)\b[^.!?\n]*[.!?]?)/g;

const SIZES = [
  { name: "desk", width: 1280, height: 800, phone: false },
  { name: "phone", width: 390, height: 844, phone: true },
] as const;
type Size = (typeof SIZES)[number];
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

// Words no seeded name shares with the mocks.
const SEED = {
  space: "Kestrel Works",
  other: "Fernhill",
  project: "Lantern Ledger",
  second: "Quarry Notes",
  tasks: ["Sand the oak lintel", "Mix the grout", "Label the seed trays", "Return the borrowed ladder"],
} as const;
const RENAMED = { space: "Realm", project: "Quest", milestone: "Leg", task: "Chore" } as const;

let copy: Copy;
let ids = { venture: "", project: "", task: "", done: "" };
const sentences = new Map<string, Set<string>>();



test.beforeAll(async () => {
  test.setTimeout(240_000);
  copy = await startCopy();
  // A new person: first run is on, and nothing is made yet.
  await send(copy, "patch", "/api/first-run", { step: 1 });
});

test.afterAll(async () => {
  const dir = join(ROOT, "e2e", "results");
  mkdirSync(dir, { recursive: true });
  const out: Record<string, string[]> = {};
  for (const [sentence, where] of sentences) out[sentence] = [...where].sort();
  writeFileSync(join(dir, "sweep.json"), `${JSON.stringify(out, null, 2)}\n`);
  await copy?.stop();
});

/** What the page reports about itself, read in the browser. */
interface Seen {
  readonly text: string;
  readonly unnamed: string[];
  readonly forbidden: string[];
  readonly sideScroll: boolean;
}

async function look(page: Page): Promise<Seen> {
  return page.evaluate(() => {
    const SELECTOR = [
      "button", "a[href]", "[role=tab]", "[role=button]", "[role=link]", "[role=menuitem]", "[role=switch]",
      "[role=checkbox]", "[role=radio]", "summary", "input[type=submit]", "input[type=button]", "input[type=checkbox]",
      "input[type=radio]",
    ].join(",");
    const shown = (el: Element): boolean => (el as HTMLElement).checkVisibility({ checkVisibilityCSS: true } as never) && el.getClientRects().length > 0;
    const nameOf = (el: Element): string => {
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        if (t) return t;
      }
      const label = el.getAttribute("aria-label")?.trim();
      if (label) return label;
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const t = [...labels].map((l) => l.textContent ?? "").join(" ").trim();
        if (t) return t;
      }
      const text = ((el as HTMLElement).innerText || el.textContent || "").trim();
      if (text) return text;
      const alt = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
      if (alt) return alt;
      const svg = el.querySelector("svg title")?.textContent?.trim();
      if (svg) return svg;
      return (el.getAttribute("title") ?? el.getAttribute("value") ?? "").trim();
    };
    const unnamed: string[] = [];
    const forbidden: string[] = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (!shown(el)) continue;
      const name = nameOf(el);
      if (name === "") unnamed.push(el.outerHTML.slice(0, 120));
      else forbidden.push(name);
    }
    return {
      text: document.body.innerText,
      unnamed,
      forbidden,
      sideScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

interface Run {
  readonly findings: string[];
  readonly problems: string[];
  readonly phone: boolean;
  readonly renamed: boolean;
}

/** Every check that reads a page or sheet that is open now. */
async function audit(page: Page, run: Run, where: string, changed = false): Promise<void> {
  const seen = await look(page);
  const add = (what: string): void => { run.findings.push(`${where}: ${what}`); };
  if (seen.text.includes(EM_DASH)) add("an em-dash in the visible text");
  for (const html of seen.unnamed) add(`a control with no accessible name ${html}`);
  for (const name of seen.forbidden) {
    if (!FORBIDDEN_CONTROL.test(name.trim())) continue;
    if (changed && /^undo$/i.test(name.trim())) continue;
    add(`a control named ${name} with no change just made`);
  }
  const lower = seen.text.toLowerCase();
  for (const name of MOCK_NAMES) if (lower.includes(name.toLowerCase())) add(`the mock example name "${name}"`);
  if (run.renamed) {
    const old = OLD_WORDS.exec(seen.text);
    if (old) add(`the old level word "${old[0]}" after the levels were renamed`);
  }
  if (run.phone && seen.sideScroll) add("a horizontal scrollbar at phone width");
  for (const match of seen.text.matchAll(IMPERATIVE)) {
    const sentence = (match[1] ?? "").trim();
    if (sentence.length < 6) continue;
    const at = sentences.get(sentence) ?? new Set<string>();
    at.add(where.split(" > ")[0] ?? where);
    sentences.set(sentence, at);
  }
}

/** Watches a page for console errors and failed requests. */
function watch(page: Page, run: Run, expected: (url: string, status: number) => boolean): void {
  page.on("pageerror", (error) => run.problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    // A failed request is reported with its address below, once.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) run.problems.push(`console error: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "";
    if (reason.includes("ERR_ABORTED")) return;
    run.problems.push(`request failed: ${request.method()} ${request.url()} ${reason}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = response.url().replace(copy.origin, "");
    if (!expected(url, response.status())) run.problems.push(`${response.status()} ${response.request().method()} ${url}`);
  });
}

async function newContext(browser: Browser, size: Size, theme: Theme, signedIn: boolean): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: copy.origin,
    ...(signedIn ? { storageState: await copy.api.storageState() } : {}),
    viewport: { width: size.width, height: size.height },
    isMobile: size.phone,
    hasTouch: size.phone,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
}

async function ready(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.waitForLoadState("networkidle");
}

/** Every route in `src/web/router.ts`, with what a copy has to hold for it to show something. */
function routes(seeded: boolean): readonly { readonly name: string; readonly path: string }[] {
  const base = [
    { name: "map", path: "/" },
    { name: "map alias", path: "/map" },
    { name: "today", path: "/today" },
    { name: "horizon", path: "/horizon" },
    { name: "add", path: "/add" },
    { name: "search", path: "/search" },
    { name: "archive", path: "/archive" },
    { name: "account", path: "/account" },
    { name: "review", path: "/review" },
  ];
  if (!seeded) return base;
  const v = `/ventures/${ids.venture}`;
  return [
    ...base,
    { name: "space board", path: `${v}/board` },
    { name: "space projects", path: `${v}/projects` },
    { name: "space today", path: `${v}/today` },
    { name: "old board", path: `/board/${ids.venture}` },
    { name: "project", path: `${v}/projects/${ids.project}` },
    { name: "task page", path: `${v}/tasks/${ids.task}` },
    { name: "task sheet", path: `/today?task=${ids.task}` },
  ];
}

/** The sheets that open over a page, opened one at a time and read. */
async function sheets(page: Page, run: Run, label: string, seeded: boolean): Promise<void> {
  const close = async (): Promise<void> => { await page.keyboard.press("Escape"); await page.waitForTimeout(150); };
  await ready(page, "/");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  await audit(page, run, `${label} > command palette`);
  await close();
  await ready(page, "/");
  await page.keyboard.press("Shift+/");
  await page.waitForTimeout(300);
  await audit(page, run, `${label} > shortcuts sheet`);
  await close();
  if (!seeded) return;
  await ready(page, "/");
  const canvas = page.getByRole("button", { name: "Canvas", exact: true });
  if (await canvas.count() > 0) {
    await canvas.first().click();
    await page.waitForTimeout(400);
    await audit(page, run, `${label} > map canvas`, true);
  }
  await ready(page, "/today");
  const more = page.locator("button.trow-more").first();
  if (await more.count() > 0) {
    await more.click();
    await page.waitForTimeout(300);
    await audit(page, run, `${label} > task options sheet`);
    await close();
  }
  await ready(page, `/ventures/${ids.venture}/board`);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  if (await settings.count() > 0) {
    await settings.first().click();
    await page.waitForTimeout(300);
    await audit(page, run, `${label} > space settings`);
    await close();
  }
}

const SIGNED_IN_OK = (): boolean => false;

async function sweepSignedIn(browser: Browser, size: Size, theme: Theme, seeded: boolean, renamed: boolean, label: string): Promise<void> {
  await send(copy, "patch", "/api/appearance", { theme });
  const context = await newContext(browser, size, theme, true);
  const page = await context.newPage();
  const run: Run = { findings: [], problems: [], phone: size.phone, renamed };
  watch(page, run, SIGNED_IN_OK);
  try {
    for (const route of routes(seeded)) {
      await ready(page, route.path);
      await audit(page, run, `${label} ${theme} ${size.name} > ${route.name} ${route.path}`);
    }
    await sheets(page, run, `${label} ${theme} ${size.name}`, seeded);
  } finally {
    await context.close();
  }
  expect([...run.findings, ...run.problems], `${label}, ${theme}, ${size.name}`).toEqual([]);
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`signed out, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      test.setTimeout(300_000);
      const context = await newContext(browser, size, theme, false);
      const page = await context.newPage();
      const run: Run = { findings: [], problems: [], phone: size.phone, renamed: false };
      // Asking for the account while signed out is answered 401, which is the answer.
      watch(page, run, (url, status) => status === 401 && url.startsWith("/auth/me"));
      try {
        for (const path of ["/", "/today", "/account", "/search", "/invite", "/reset"]) {
          await ready(page, path);
          await audit(page, run, `signed out ${theme} ${size.name} > ${path}`);
        }
      } finally {
        await context.close();
      }
      expect([...run.findings, ...run.problems]).toEqual([]);
    });
  }
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`a new account with first run on, ${theme}, ${size.name}`, async ({ browser }) => {
      test.setTimeout(300_000);
      await sweepSignedIn(browser, size, theme, false, false, "fresh");
    });
  }
}

test("a seeded copy", async () => {
  test.setTimeout(120_000);
  await send(copy, "patch", "/api/first-run", { step: null });
  const venture = await send<{ id: string }>(copy, "post", "/api/ventures", { name: SEED.space });
  const other = await send<{ id: string }>(copy, "post", "/api/ventures", { name: SEED.other });
  const project = await send<{ id: string }>(copy, "post", "/api/projects", { ventureId: venture.id, name: SEED.project });
  await send(copy, "post", "/api/projects", { ventureId: venture.id, name: SEED.second });
  const [first, second, third, fourth] = SEED.tasks;
  const a = await send<{ id: string }>(copy, "post", "/api/tasks", { ventureId: venture.id, projectId: project.id, title: first, dueOn: isoDay(0), pickedOn: isoDay(0) });
  await send(copy, "post", "/api/tasks", { ventureId: venture.id, projectId: project.id, title: second, dueOn: isoDay(-2) });
  await send(copy, "post", "/api/tasks", { ventureId: venture.id, projectId: project.id, title: third, dueOn: isoDay(2) });
  const done = await send<{ id: string }>(copy, "post", "/api/tasks", { ventureId: other.id, title: fourth, dueOn: isoDay(0), pickedOn: isoDay(0) });
  ids = { venture: venture.id, project: project.id, task: a.id, done: done.id };
});

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`a seeded copy, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      test.setTimeout(600_000);
      await sweepSignedIn(browser, size, theme, true, false, "seeded");
    });
  }
}

interface Control {
  readonly i: number;
  readonly name: string;
  readonly href: string | null;
  readonly selected: boolean;
  /** Something else is drawn over its middle. */
  readonly covered: boolean;
  /** A sheet or dialog is open, and this control is not in it. */
  readonly behindSheet: boolean;
}

/** Marks every visible control with `data-sweep` and says what each is. */
async function mark(page: Page): Promise<Control[]> {
  return page.evaluate(() => {
    const SELECTOR = [
      "button", "a[href]", "[role=tab]", "[role=button]", "[role=link]", "[role=menuitem]", "[role=switch]",
      "[role=checkbox]", "[role=radio]", "summary", "input[type=submit]", "input[type=button]", "input[type=checkbox]",
      "input[type=radio]",
    ].join(",");
    const out: { i: number; name: string; href: string | null; selected: boolean; covered: boolean; behindSheet: boolean }[] = [];
    const sheet = document.querySelector("[role=dialog],dialog[open],[aria-modal=true]");
    let i = 0;
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (!(el as HTMLElement).checkVisibility({ checkVisibilityCSS: true } as never) || el.getClientRects().length === 0) continue;
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
      const label = el.getAttribute("aria-label")?.trim() || ((el as HTMLElement).innerText || el.textContent || "").trim() || el.getAttribute("title") || "";
      const selected = ["aria-selected", "aria-current", "aria-pressed"].some((a) => {
        const v = el.getAttribute(a);
        return v !== null && v !== "false";
      });
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      // A control below the fold has nothing to be measured against yet.
      const inView = box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth;
      // The tab bar is fixed to the foot of the screen and a page scrolls under it on purpose, so a
      // control that reaches under it is not drawn over; the click below still has to reach it.
      const underBar = (node: Element | null): boolean => {
        for (let n: Element | null = node; n !== null; n = n.parentElement) {
          const s = getComputedStyle(n);
          if ((s.position === "fixed" || s.position === "sticky") && n.getBoundingClientRect().bottom >= window.innerHeight - 1) return true;
        }
        return false;
      };
      const covered = inView && (top === null || !(el.contains(top) || top.contains(el))) && !underBar(top);
      el.setAttribute("data-sweep", String(i));
      out.push({ i, name: label, href: el.getAttribute("href"), selected, covered, behindSheet: sheet !== null && !sheet.contains(el) });
      i += 1;
    }
    return out;
  });
}

async function signature(page: Page, sweep: string): Promise<string> {
  return page.evaluate((i) => JSON.stringify([
    location.href,
    document.body.innerText,
    document.querySelectorAll("[role=dialog],dialog[open],[aria-modal=true]").length,
    document.documentElement.getAttribute("data-theme"),
    document.querySelector(`[data-sweep="${i}"]`)?.outerHTML ?? "gone",
    document.activeElement?.getAttribute("data-sweep") ?? "",
  ]), sweep);
}

for (const size of SIZES) {
  test(`every control does something, light, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
    test.setTimeout(1_800_000);
    await send(copy, "patch", "/api/appearance", { theme: "light" });
    const context = await newContext(browser, size, "light", true);
    const page = await context.newPage();
    const run: Run = { findings: [], problems: [], phone: size.phone, renamed: false };
    let requests = 0;
    let events = 0;
    watch(page, run, SIGNED_IN_OK);
    page.on("request", () => { requests += 1; });
    page.on("popup", () => { events += 1; });
    page.on("download", () => { events += 1; });
    const idle: string[] = [];
    // Clicking Account's switches changes the account for every page after it. Each page starts
    // from the settings the copy began with.
    const read = await copy.api.get(`${copy.origin}/api/appearance`);
    const baseline = (await read.json()) as Record<string, unknown>;
    // The copy's encryption is not an appearance to put back.
    delete baseline.encryption;
    try {
      for (const route of routes(true)) {
        const reset = await copy.api.patch(`${copy.origin}/api/appearance`, { data: baseline, headers: { origin: copy.origin } });
        expect(reset.status(), `putting the settings back: ${await reset.text()}`).toBeLessThan(300);
        // A control on the Account page runs the first steps again; put the copy back as it began.
        await send(copy, "patch", "/api/first-run", { step: null });
        await ready(page, route.path);
        const controls = await mark(page);
        for (const control of controls) {
          const where = `${route.path} > ${control.name || "(no name)"}`;
          if (DESTRUCTIVE.test(control.name)) continue;
          if (control.selected) continue;
          if (control.href !== null && /^(https?:|mailto:|tel:)/.test(control.href) && !control.href.startsWith(copy.origin)) continue;
          await ready(page, route.path);
          const now = await mark(page);
          const same = now[control.i];
          if (!same || same.name !== control.name) continue;
          // A sheet over the page covers the rest of it, on purpose.
          if (same.behindSheet) continue;
          if (same.covered) { idle.push(`${where}: another element is drawn over it`); continue; }
          const before = await signature(page, String(control.i));
          requests = 0;
          events = 0;
          try {
            const target = page.locator(`[data-sweep="${control.i}"]`);
            // A drag handle moves with the arrow keys; a click is not what it is for.
            if (/^reorder /i.test(control.name)) {
              await target.focus();
              await page.keyboard.press("ArrowDown");
              await page.waitForTimeout(450);
              // The last row has nowhere to go down.
              if (requests === 0) await page.keyboard.press("ArrowUp");
            } else {
              await target.click({ timeout: 4000 });
            }
          } catch (error) {
            idle.push(`${where}: could not be clicked (${String(error).split("\n")[0]})`);
            continue;
          }
          await page.waitForTimeout(450);
          const after = await signature(page, String(control.i)).catch(() => "navigated");
          await audit(page, run, `${size.name} ${where} (after the click)`, true);
          if (before === after && requests === 0 && events === 0) idle.push(`${where}: nothing changed`);
        }
      }
    } finally {
      await context.close();
    }
    expect({ idle, findings: run.findings, problems: run.problems }, `controls at ${size.name}`).toEqual({ idle: [], findings: [], problems: [] });
  });
}

test("the four level names renamed", async () => {
  await send(copy, "patch", "/api/appearance", { levelNames: RENAMED });
});

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`renamed levels, ${theme}, ${size.name} ${size.width} by ${size.height}`, async ({ browser }) => {
      test.setTimeout(600_000);
      await sweepSignedIn(browser, size, theme, true, true, "renamed");
    });
  }
}
