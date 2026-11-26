import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { OPERATOR_EMAIL, PASSWORD, ROOT, WRANGLER, startServer } from "./copy.js";

/**
 * Full-account encryption in a real browser (VEMI-013, full-encryption). The copy runs at
 * `http://localhost:<port>` (WebAuthn refuses an IP address) and every page gets a Chromium virtual
 * authenticator over CDP with the PRF extension, so the real key, the real envelopes and the real
 * Worker are all used.
 *
 * One person, in order: an account holding tasks, a note, a project brief, a link, a tag, a saved
 * filter and renamed levels; encryption turned on from Privacy and security; every table of the
 * database file read and none of the seeded words found; the screens at desk and phone in both
 * themes; a search that finds the note; a task added, edited and ticked and the page reloaded; a
 * second device opened by the recovery key; encryption turned off and the words readable again with
 * the same record counts.
 */

const API_ROOT = ROOT;
const SHOTS = join(ROOT, "e2e", "screenshots");

const SPACE = "ZEBRASPACE Allotment";
const PROJECT = "ZEBRAPROJ Back beds";
const DESCRIPTION = "ZEBRADESC the long south border";
const WHO_FOR = "ZEBRAWHO people who keep a quiet garden";
const MILESTONE = "ZEBRAMILE First frost";
const TASK = "ZEBRATASK Turn the soil";
const TASK_BODY = "ZEBRABODY dig the east bed before the frost";
const STEP = "ZEBRASTEP borrow the fork";
const OTHER_TASK = "ZEBRAOTHER Order seed potatoes";
const NOTE = "ZEBRANOTE the shed key is under the blue pot";
const LINK_URL = "https://example.test/ZEBRALINK-seed-catalogue";
const LINK_LABEL = "ZEBRALABEL Seed catalogue";
const TAG = "ZEBRATAG autumn";
const FILTER_NAME = "ZEBRAFILT Frost jobs";
const FILTER_QUERY = "ZEBRAQUERY frost";
const LEVELS = { space: "ZEBRALVSP Plot", project: "ZEBRALVPR Bed", milestone: "ZEBRALVMI Season", task: "ZEBRALVTA Chore" };
const SEEDED = [
  "ZEBRA", "quiet garden", "blue pot", "east bed", "south border", "borrow the fork", "seed potatoes", "Seed catalogue",
];

interface Copy {
  readonly origin: string;
  readonly persist: string;
  readonly api: APIRequestContext;
  readonly stop: () => Promise<void>;
}

async function startCopy(): Promise<Copy> {
  const server = await startServer({ name: "encryption", host: "localhost" });
  const origin = server.origin;
  const api = await request.newContext();
  const claimed = await api.post(`${origin}/auth/claim`, { data: { email: OPERATOR_EMAIL, password: PASSWORD }, headers: { origin } });
  expect(claimed.status()).toBe(200);
  const skipped = await api.patch(`${origin}/api/first-run`, { data: { step: null }, headers: { origin } });
  expect(skipped.status()).toBe(200);

  return {
    origin,
    persist: server.persist,
    api,
    stop: async () => {
      await api.dispose();
      await server.stop();
    },
  };
}

let copy: Copy;
let ids: { venture: string; project: string; task: string; other: string; note: string };

const send = async <T>(method: "post" | "patch", path: string, data: object): Promise<T> => {
  const response = await copy.api[method](`${copy.origin}${path}`, { data, headers: { origin: copy.origin } });
  expect(response.status(), `${method} ${path} ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
};

/** One wrangler call, tried again when the machine drops it (it starts a whole local runtime each time). */
function sqlEach(commands: readonly string[]): Record<string, unknown>[][] {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const out = execFileSync(process.execPath, [
        WRANGLER, "d1", "execute", "DB", "--local", "--persist-to", copy.persist, "--json", "--command", commands.join("; "),
      ], { cwd: API_ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results: Record<string, unknown>[] }[];
      return parsed.map((p) => p.results);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** Every table of the database file: its rows as text, and how many it holds. Nothing is skipped. */
function wholeDatabase(): { readonly text: string; readonly counts: Record<string, number> } {
  const tables = (sqlEach(["SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"])[0] ?? [])
    .map((r) => String(r["name"]));
  expect(tables.length).toBeGreaterThan(20);
  const results = sqlEach(tables.map((t) => `SELECT * FROM "${t}"`));
  expect(results).toHaveLength(tables.length);
  const counts: Record<string, number> = {};
  tables.forEach((t, i) => { counts[t] = results[i]?.length ?? 0; });
  return { text: JSON.stringify(results), counts };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  copy = await startCopy();
  mkdirSync(SHOTS, { recursive: true });
  const venture = await send<{ id: string }>("post", "/api/ventures", { name: SPACE });
  const project = await send<{ id: string }>("post", "/api/projects", { ventureId: venture.id, name: PROJECT });
  await send("patch", `/api/projects/${project.id}`, { description: DESCRIPTION, whoFor: WHO_FOR });
  const milestone = await send<{ id: string }>("post", "/api/milestones", { projectId: project.id, name: MILESTONE });
  const tag = await send<{ id: string }>("post", "/api/tags", { name: TAG });
  const task = await send<{ id: string }>("post", "/api/tasks", {
    ventureId: venture.id, projectId: project.id, milestoneId: milestone.id, title: TASK, body: TASK_BODY,
    checklist: [{ text: STEP, done: false }], tagIds: [tag.id],
  });
  const other = await send<{ id: string }>("post", "/api/tasks", { ventureId: venture.id, projectId: project.id, title: OTHER_TASK });
  const note = await send<{ id: string }>("post", "/api/notes", { projectId: project.id, body: NOTE });
  await send("post", "/api/links", { projectId: project.id, url: LINK_URL, label: LINK_LABEL });
  await send("post", "/api/filters", { name: FILTER_NAME, query: FILTER_QUERY });
  await send("patch", "/api/appearance", { levelNames: LEVELS });
  ids = { venture: venture.id, project: project.id, task: task.id, other: other.id, note: note.id };
});

test.afterAll(async () => {
  await copy?.stop();
});

interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly errors: string[];
}

async function newDevice(
  browser: Browser,
  options: { readonly prf?: boolean; readonly phone?: boolean } = {},
): Promise<Device> {
  const phone = options.phone === true;
  const context = await browser.newContext({
    baseURL: copy.origin,
    storageState: await copy.api.storageState(),
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: phone,
    hasTouch: phone,
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctapVersion: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: options.prf !== false,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page, errors };
}

const projectPath = (): string => `/ventures/${ids.venture}/projects/${ids.project}`;
const nav = (page: Page) => page.getByRole("navigation", { name: "Account sections" });
const panel = (page: Page) => page.locator(".encryption-panel");

async function openPrivacy(page: Page): Promise<void> {
  await page.goto("/account");
  await nav(page).getByRole("button", { name: /^Privacy and security( ›)?$/ }).click();
  await expect(page.getByRole("heading", { name: "Privacy and security", exact: true })).toBeVisible();
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
}

const noSideways = async (page: Page, what: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
};

/** What a screen must never show: an envelope where a person's words belong. */
const noEnvelope = async (page: Page, what: string): Promise<void> => {
  const body = await page.locator("body").innerText();
  expect(body, `${what} shows an envelope`).not.toMatch(/\bv1\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{16}\./);
};

let recoveryKey = "";
let holder: Device;
let before: Record<string, number> = {};

test("turn encryption on and the database file holds none of the seeded words", async ({ browser }) => {
  test.setTimeout(300_000);
  const plainDb = wholeDatabase();
  before = plainDb.counts;
  for (const word of ["ZEBRASPACE", "ZEBRANOTE", "ZEBRATAG", "ZEBRALVTA", "ZEBRAFILT", "ZEBRASTEP"]) {
    expect(plainDb.text, `${word} is there to be found before`).toContain(word);
  }

  holder = await newDevice(browser);
  const { page } = holder;
  // Turn on has nothing to decide with until the key rows have answered, so a first press that
  // finds the Worker still cold is pressed again after a fresh look.
  await expect(async () => {
    await openPrivacy(page);
    await expect(panel(page)).toContainText("Off");
    await panel(page).getByRole("button", { name: "Turn on", exact: true }).click();
    // No key yet: set one up first, Face ID, then the recovery key.
    await page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click({ timeout: 10_000 });
  }).toPass({ timeout: 90_000 });
  const key = (await page.locator(".recovery-key-text").innerText()).trim();
  expect(key).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  recoveryKey = key;
  await page.getByLabel("Last group", { exact: true }).fill(key.split("-").pop() ?? "");
  await page.getByRole("button", { name: "Done", exact: true }).click();

  // The five lines, then the switch.
  await expect(page.locator(".encryption-lines li")).toHaveCount(5);
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(panel(page)).toContainText("On", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Turn off", exact: true })).toBeVisible();

  const after = wholeDatabase();
  for (const word of SEEDED) expect(after.text, `the database file holds "${word}"`).not.toContain(word);
  // The key is the one new kind of row; every record of the person's is still there, none lost or added.
  const { key_wrap: made, ...onData } = after.counts;
  const { key_wrap: none, ...beforeData } = before;
  expect(none).toBe(0);
  expect(made).toBeGreaterThan(0);
  expect(onData).toEqual(beforeData);
  const state = (await (await copy.api.get(`${copy.origin}/api/encryption`, { headers: { origin: copy.origin } })).json()) as { state: string; unsealed: number };
  expect(state.state).toBe("on");
  expect(state.unsealed).toBe(0);
  expect(holder.errors).toEqual([]);
});

const SCREENS = [
  { name: "map", path: (): string => "/", shows: SPACE },
  { name: "today", path: (): string => "/today", shows: SPACE },
  { name: "project", path: projectPath, shows: PROJECT },
  { name: "search", path: (): string => "/search", shows: "" },
  { name: "account", path: (): string => "/account", shows: "Account" },
] as const;

for (const size of [{ name: "desk", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }] as const) {
  test(`Map, Today, a project, Search, Account and the palette on the encrypted account at ${size.name} size in both themes`, async () => {
    test.setTimeout(240_000);
    const { page } = holder;
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const theme of ["light", "dark"] as const) {
      await send("patch", "/api/appearance", { theme });
      for (const screen of SCREENS) {
        await page.goto(screen.path());
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        if (screen.shows !== "") await expect(page.locator("body")).toContainText(screen.shows, { timeout: 30_000 });
        await page.waitForLoadState("networkidle");
        await noEnvelope(page, `${screen.name}, ${size.name}, ${theme}`);
        await noSideways(page, `${screen.name}, ${size.name}, ${theme}`);
        await page.screenshot({ path: join(SHOTS, `encryption-${screen.name}-${theme}-${size.name}.png`) });
      }
      // The palette, from any route: it finds a task by its opened title.
      await page.goto("/today");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("Control+k");
      const field = page.getByRole("textbox", { name: "command" });
      await expect(field).toBeVisible();
      await field.fill("Turn the soil");
      await expect(page.getByRole("dialog", { name: "Command palette" })).toContainText(/ZEBRATASK Turn the soil/i, { timeout: 20_000 });
      await noEnvelope(page, `palette, ${size.name}, ${theme}`);
      await noSideways(page, `palette, ${size.name}, ${theme}`);
      await page.screenshot({ path: join(SHOTS, `encryption-palette-${theme}-${size.name}.png`) });
      await page.keyboard.press("Escape");
    }
    expect(holder.errors).toEqual([]);
  });
}

test("search finds a note on the device and sends no search request", async () => {
  const { page } = holder;
  await page.setViewportSize({ width: 1280, height: 800 });
  const searched: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/search") searched.push(r.url()); });
  // A read the Worker refuses while it is still warming up is not asked again by itself, so a look that finds nothing is repeated once with a fresh page.
  await expect(async () => {
    await page.goto("/search");
    await page.getByRole("textbox", { name: "search" }).fill("shed key");
    await expect(page.locator(".results")).toContainText("shed key", { timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
  expect(searched).toEqual([]);
  // The Worker's own search holds nothing to find while the account is on.
  const served = await copy.api.get(`${copy.origin}/api/search?q=${encodeURIComponent("shed key")}`, { headers: { origin: copy.origin } });
  expect(await served.json()).toEqual({ results: [] });
  expect(holder.errors).toEqual([]);
});

const ADDED = "ZEBRAADDED Water the beans";
const RENAMED = "ZEBRARENAMED Water the beans well";

test("a task is added, edited and ticked, and the page reloaded still shows them", async () => {
  test.setTimeout(150_000);
  const { page } = holder;
  await page.goto("/today");
  await page.getByRole("textbox", { name: "Add to today" }).fill(ADDED);
  await page.locator(".today-add").getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".today")).toContainText(ADDED, { timeout: 20_000 });
  await expect.poll(() => wholeDatabase().counts["task"], { timeout: 30_000 }).toBe((before["task"] ?? 0) + 1);
  expect(wholeDatabase().text).not.toContain("ZEBRAADDED");

  // Edit: open it, rename it where the title is.
  await page.locator(".today").getByRole("button", { name: ADDED }).first().click();
  const detail = page.getByRole("dialog", { name: /chore/i });
  await detail.getByRole("button", { name: ADDED }).click();
  const title = page.getByRole("textbox", { name: "title" });
  await title.fill(RENAMED);
  const renamed = page.waitForResponse((r) => r.request().method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/tasks"), { timeout: 30_000 });
  await title.press("Enter");
  await expect(detail.getByRole("button", { name: RENAMED })).toBeVisible({ timeout: 20_000 });
  // The save has reached the Worker before the page is left, so a busy machine cannot drop it.
  expect((await renamed).ok()).toBe(true);

  // Tick: Today's Done on the one to do next.
  await page.goto("/today");
  await expect(page.locator(".today")).toContainText(RENAMED, { timeout: 20_000 });
  // Wait for the write itself, not for the network to go quiet: "idle" can be reported before the
  // press has sent anything, and then the database look below proves nothing.
  const ticked = page.waitForResponse((r) => r.request().method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/tasks"), { timeout: 30_000 });
  await page.getByRole("button", { name: "Done", exact: true }).first().click();
  expect((await ticked).ok()).toBe(true);
  expect(wholeDatabase().text).not.toContain("ZEBRARENAMED");

  await page.reload();
  await expect(page.locator(".clear-title")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Show 1 done/ }).click();
  await expect(page.locator(".today")).toContainText(RENAMED, { timeout: 20_000 });
  await noEnvelope(page, "Today after a reload");
  expect(holder.errors).toEqual([]);
});

test("a second device with nothing but the recovery key sees the same data", async ({ browser }) => {
  test.setTimeout(180_000);
  const lost = await newDevice(browser, { prf: false });
  const { page } = lost;
  await page.goto(projectPath());
  await expect(page.locator("body")).not.toContainText("ZEBRA");
  await page.screenshot({ path: join(SHOTS, "encryption-second-device-locked.png") });
  await page.getByRole("button", { name: "Open", exact: true }).first().click();
  await page.locator(".account-row").filter({ has: page.getByText("Recovery key", { exact: true }) }).getByRole("button", { name: "Use", exact: true }).click();
  await page.getByLabel("Recovery key", { exact: true }).fill(recoveryKey);
  await page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  const notNow = page.locator(".key-offer").getByRole("button", { name: "Not now", exact: true });
  if (await notNow.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) await notNow.click();
  // In place first, with no reload: opening the key brings the page up as it stands.
  await expect(page.locator("body")).toContainText(PROJECT, { timeout: 40_000 });
  await expect(page.locator("body")).toContainText(WHO_FOR);
  await expect(page.locator("body")).toContainText(NOTE);
  await expect(page.locator("body")).toContainText(TASK);
  await noEnvelope(page, "the second device");
  await page.goto("/");
  await expect(page.locator("body")).toContainText(SPACE, { timeout: 30_000 });
  expect(lost.errors).toEqual([]);
  await lost.context.close();
});

test("turn encryption off and the seeded words are readable again with the same record counts", async () => {
  test.setTimeout(300_000);
  const { page } = holder;
  const onCounts = wholeDatabase().counts;
  await openPrivacy(page);
  await panel(page).getByRole("button", { name: "Turn off", exact: true }).click();
  await page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  await expect(panel(page)).toContainText("Off", { timeout: 120_000 });
  await expect(panel(page).getByRole("button", { name: "Turn on", exact: true })).toBeVisible();

  const off = wholeDatabase();
  for (const word of [SPACE, PROJECT, DESCRIPTION, WHO_FOR, MILESTONE, TASK, TASK_BODY, STEP, OTHER_TASK, NOTE, LINK_URL, LINK_LABEL, TAG, FILTER_NAME, FILTER_QUERY, LEVELS.task, RENAMED]) {
    expect(off.text, `"${word}" is readable again`).toContain(word);
  }
  expect(off.counts).toEqual(onCounts);
  const { key_wrap: kept, ...rest } = off.counts;
  const { key_wrap: _none, ...first } = before;
  expect(kept).toBeGreaterThan(0);
  expect(rest).toEqual({ ...first, task: (first["task"] ?? 0) + 1 });
  const state = (await (await copy.api.get(`${copy.origin}/api/encryption`, { headers: { origin: copy.origin } })).json()) as { state: string; sealed: number };
  expect(state.state).toBe("off");
  expect(state.sealed).toBe(0);
  expect(holder.errors).toEqual([]);
});
