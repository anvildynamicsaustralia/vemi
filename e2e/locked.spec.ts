import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { OPERATOR_EMAIL, PASSWORD, ROOT, WRANGLER, startServer } from "./copy.js";

/**
 * Locked notes in a real browser (VEMI-013, locked-notes). The copy runs at `http://localhost:<port>`
 * (WebAuthn refuses an IP address) and every page gets a Chromium virtual authenticator over CDP
 * with the PRF extension, so the real key, the real envelopes and the real Worker are all used.
 *
 * One person, in order: lock a brief field, a project note and a task description; read the raw
 * database rows and find no plaintext; open them on a second device by the QR link and on a third
 * by the recovery key; search them on the device; set App lock to 1 minute with a fake clock and
 * open it; export, restore the export and reopen the note; then the project page at desk and phone
 * in both themes.
 */

const API_ROOT = ROOT;
const SHOTS = join(ROOT, "e2e", "screenshots");

const WHO_FOR = "ZEBRAWHO people who keep a quiet garden";
const NOTE = "ZEBRANOTE the shed key is under the blue pot";
const BODY = "ZEBRATASK dig the east bed before the frost";

interface Copy {
  readonly origin: string;
  readonly persist: string;
  readonly api: APIRequestContext;
  readonly stop: () => Promise<void>;
}

async function startCopy(): Promise<Copy> {
  const server = await startServer({ name: "locked", host: "localhost" });
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
let ids: { venture: string; project: string; task: string; note: string };

const send = async <T>(method: "post" | "patch", path: string, data: object): Promise<T> => {
  const response = await copy.api[method](`${copy.origin}${path}`, { data, headers: { origin: copy.origin } });
  expect(response.status(), `${method} ${path} ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
};

/** The raw rows of the Worker's own test database, read with SQL and nothing else in between. */
function rawRows(sql: string): Record<string, unknown>[] {
  const out = execFileSync(process.execPath, [
    WRANGLER, "d1", "execute", "DB", "--local", "--persist-to", copy.persist, "--json", "--command", sql,
  ], { cwd: API_ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" }, encoding: "utf8" });
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results: Record<string, unknown>[] }[];
  return parsed.flatMap((p) => p.results);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  copy = await startCopy();
  mkdirSync(SHOTS, { recursive: true });
  const venture = await send<{ id: string }>("post", "/api/ventures", { name: "Garden" });
  const project = await send<{ id: string }>("post", "/api/projects", { ventureId: venture.id, name: "Back beds" });
  await send("patch", `/api/projects/${project.id}`, { whoFor: WHO_FOR });
  const task = await send<{ id: string }>("post", "/api/tasks", { ventureId: venture.id, projectId: project.id, title: "Turn the soil", body: BODY });
  const note = await send<{ id: string }>("post", "/api/notes", { projectId: project.id, body: NOTE });
  ids = { venture: venture.id, project: project.id, task: task.id, note: note.id };
});

test.afterAll(async () => {
  await copy?.stop();
});

interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly errors: string[];
  readonly cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>>;
  readonly authenticatorId: string;
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
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
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
  return { context, page, errors, cdp, authenticatorId };
}

const projectPath = (): string => `/ventures/${ids.venture}/projects/${ids.project}`;
const taskPath = (): string => `/ventures/${ids.venture}/tasks/${ids.task}`;
const whoStep = (page: Page) => page.locator(".bstep").filter({ hasText: "Who it's for" });
const noteEntry = (page: Page) => page.locator(".notes-entry").first();
const nav = (page: Page) => page.getByRole("navigation", { name: "Account sections" });
const rowButton = (page: Page, title: string, button: string) =>
  page.locator(".account-row").filter({ has: page.getByText(title, { exact: true }) }).getByRole("button", { name: button, exact: true });

async function openAccountSection(page: Page, name: string): Promise<void> {
  await page.goto("/account");
  await nav(page).getByRole("button", { name: new RegExp(`^${name}( ›)?$`) }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

/** Reads the shown recovery key, types its last group, presses Done. */
async function finishRecovery(page: Page): Promise<string> {
  const key = (await page.locator(".recovery-key-text").innerText()).trim();
  expect(key).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  await page.getByLabel("Last group", { exact: true }).fill(key.split("-").pop() ?? "");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  return key;
}

/** Declines the passkey offer a way in without Face ID can make, when it comes. */
async function declineOffer(page: Page): Promise<void> {
  const notNow = page.locator(".key-offer").getByRole("button", { name: "Not now", exact: true });
  const mark = page.locator(".lock-mark").first();
  await Promise.race([
    notNow.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined),
    mark.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}

const noSideways = async (page: Page, what: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
};

let recoveryKey = "";
let holder: Device;

test("lock a brief field, a note and a task description; the database holds only envelopes", async ({ browser }) => {
  test.setTimeout(150_000);
  holder = await newDevice(browser);
  const { page } = holder;
  await page.goto(projectPath());
  await expect(whoStep(page)).toContainText(WHO_FOR);

  // The first lock sets the key up: Face ID or a fingerprint, then the recovery key, then the seal.
  await whoStep(page).getByRole("button", { name: "Lock", exact: true }).click();
  await page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  recoveryKey = await finishRecovery(page);
  await expect(whoStep(page).locator(".lock-mark")).toBeVisible();
  await expect(whoStep(page)).toContainText(WHO_FOR);

  await noteEntry(page).getByRole("button", { name: "Lock", exact: true }).click();
  await expect(noteEntry(page).locator(".lock-mark")).toBeVisible();
  await expect(noteEntry(page)).toContainText(NOTE);

  await page.goto(taskPath());
  await expect(page.locator(".detail-body")).toContainText(BODY);
  await page.locator(".detail-body").getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.locator(".detail-body .lock-mark")).toBeVisible();
  await expect(page.locator(".detail-body")).toContainText(BODY);

  // Saves go through the outbox; wait for the Worker to hold all three.
  await expect.poll(() => rawRows(`SELECT body FROM note WHERE id = '${ids.note}'`)[0]?.["body"], { timeout: 20_000 }).toMatch(/^v1\./);
  await expect.poll(() => rawRows(`SELECT body FROM task WHERE id = '${ids.task}'`)[0]?.["body"], { timeout: 20_000 }).toMatch(/^v1\./);
  await expect.poll(() => rawRows(`SELECT who_for FROM project WHERE id = '${ids.project}'`)[0]?.["who_for"], { timeout: 20_000 }).toMatch(/^v1\./);

  const raw = JSON.stringify([
    rawRows(`SELECT * FROM project WHERE id = '${ids.project}'`),
    rawRows(`SELECT * FROM task WHERE id = '${ids.task}'`),
    rawRows(`SELECT * FROM note WHERE id = '${ids.note}'`),
  ]);
  for (const word of ["ZEBRAWHO", "ZEBRANOTE", "ZEBRATASK", "quiet garden", "blue pot", "east bed"]) {
    expect(raw, `the raw rows hold "${word}"`).not.toContain(word);
  }
  // What the Worker answers over the API is the same envelope, never the words.
  const answered = await (await copy.api.get(`${copy.origin}/api/locked`, { headers: { origin: copy.origin } })).json() as { value: string }[];
  expect(answered).toHaveLength(3);
  expect(JSON.stringify(answered)).not.toContain("ZEBRA");
  expect(holder.errors).toEqual([]);
});

test("a second device opens the locked things by the QR link", async ({ browser }) => {
  test.setTimeout(180_000);
  const fresh = await newDevice(browser, { prf: false });
  await fresh.page.goto(projectPath());
  await expect(noteEntry(fresh.page)).toContainText("Locked");
  await expect(noteEntry(fresh.page)).not.toContainText("ZEBRA");
  await noteEntry(fresh.page).getByRole("button", { name: "Open", exact: true }).click();
  await fresh.page.getByRole("button", { name: "Show QR", exact: true }).click();
  const link = (await fresh.page.locator(".pair-link").innerText()).trim();
  expect(link).toContain(`${copy.origin}/account#pair=`);
  await expect(fresh.page.getByRole("img", { name: /QR code/ })).toBeVisible();

  await holder.page.goto("about:blank");
  await holder.page.goto(link);
  await expect(holder.page.getByText("Let a new device open locked things?")).toBeVisible();
  await holder.page.getByRole("button", { name: "Allow", exact: true }).click();
  await holder.page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  await expect(holder.page.getByText("Let a new device open locked things?")).toHaveCount(0);

  await expect(noteEntry(fresh.page)).toContainText(NOTE, { timeout: 40_000 });
  await expect(whoStep(fresh.page)).toContainText(WHO_FOR);
  await fresh.page.goto(taskPath());
  await expect(fresh.page.locator(".detail-body")).toContainText(BODY);
  expect(fresh.errors).toEqual([]);
  await fresh.context.close();
});

test("a device with nothing but the recovery key opens them too", async ({ browser }) => {
  test.setTimeout(150_000);
  const lost = await newDevice(browser, { prf: false });
  await lost.page.goto(projectPath());
  await noteEntry(lost.page).getByRole("button", { name: "Open", exact: true }).click();
  await rowButton(lost.page, "Recovery key", "Use").click();
  await lost.page.getByLabel("Recovery key", { exact: true }).fill(recoveryKey);
  await lost.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  await declineOffer(lost.page);
  await expect(noteEntry(lost.page)).toContainText(NOTE);
  await expect(whoStep(lost.page)).toContainText(WHO_FOR);
  expect(lost.errors).toEqual([]);
  await lost.context.close();
});

test("search finds locked words on the device and the Worker does not", async () => {
  const { page } = holder;
  await page.goto("/search");
  await page.getByRole("textbox", { name: "search" }).fill("shed key");
  await expect(page.locator(".result-kind", { hasText: "(locked)" })).toBeVisible();
  // The Worker's own search never matches or lists what is sealed.
  const served = await copy.api.get(`${copy.origin}/api/search?q=${encodeURIComponent("shed key")}`, { headers: { origin: copy.origin } });
  expect(served.status()).toBe(200);
  expect(await served.text()).not.toContain("shed key");
  expect(holder.errors).toEqual([]);
});

test("an export keeps locked words locked, and a restore of it reopens the note", async () => {
  test.setTimeout(180_000);
  const { page } = holder;
  await openAccountSection(page, "Your data");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await expect(page.getByText("Keep locked content locked in the file?")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  const file = join(tmpdir(), `vemi-e2e-locked-${Date.now()}.json`);
  await (await downloading).saveAs(file);
  const { readFileSync } = await import("node:fs");
  const exported = readFileSync(file, "utf8");
  rmSync(file, { force: true });
  expect(exported).not.toContain("ZEBRA");
  expect(exported).not.toContain("shed key");

  await page.getByLabel("Export file").setInputFiles({ name: "vemi-export.json", mimeType: "application/json", buffer: Buffer.from(exported) });
  await expect(page.getByText("vemi-export.json holds")).toBeVisible();
  // The file holds locked content, so it asks for one of the file's own ways in first.
  await page.getByLabel("Recovery key to open the key", { exact: true }).fill(recoveryKey);
  await page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  await page.getByRole("textbox", { name: "Type replace to restore" }).fill("replace");
  await page.getByRole("button", { name: "Replace everything", exact: true }).click();
  await page.waitForURL(/\/account/, { timeout: 30_000 });
  await page.waitForLoadState("networkidle");

  // Every row has a new id now; the sealed fields were resealed to them on this device.
  const where = await (await copy.api.get(`${copy.origin}/api/locked`, { headers: { origin: copy.origin } })).json() as { kind: string; id: string; value: string; ventureId: string | null; projectId: string | null; taskId: string | null }[];
  expect(where).toHaveLength(3);
  expect(JSON.stringify(where)).not.toContain("ZEBRA");
  const note = where.find((w) => w.kind === "notes");
  expect(note?.id).toBeDefined();
  expect(note?.id).not.toBe(ids.note);
  const rows = rawRows(`SELECT body FROM note WHERE id = '${note?.id}'`);
  expect(String(rows[0]?.["body"])).toMatch(/^v1\./);
  expect(String(rows[0]?.["body"])).not.toContain("ZEBRA");
  const mine = where.find((w) => w.kind === "projects");
  ids = { ...ids, venture: mine?.ventureId ?? ids.venture, project: mine?.id ?? ids.project, note: note?.id ?? ids.note };
  const taskRow = where.find((w) => w.kind === "tasks");
  ids = { ...ids, task: taskRow?.id ?? ids.task };

  await page.goto(projectPath());
  await expect(noteEntry(page)).toContainText(NOTE, { timeout: 30_000 });
  await expect(whoStep(page)).toContainText(WHO_FOR);
  expect(holder.errors).toEqual([]);
});

for (const size of [{ name: "desk", phone: false }, { name: "phone", phone: true }] as const) {
  test(`the project page, locked and opened, at ${size.name} size in both themes`, async ({ browser }) => {
    test.setTimeout(180_000);
    const d = await newDevice(browser, { prf: false, phone: size.phone });
    for (const theme of ["light", "dark"] as const) {
      await send("patch", "/api/appearance", { theme });
      await d.page.goto(projectPath());
      await expect(d.page.locator("html")).toHaveAttribute("data-theme", theme);
      if (theme === "light") {
        await expect(noteEntry(d.page)).toContainText("Locked");
        await expect(d.page.locator("body")).not.toContainText("ZEBRA");
        await noSideways(d.page, `locked, ${size.name}, ${theme}`);
        await d.page.screenshot({ path: join(SHOTS, `locked-closed-${theme}-${size.name}.png`) });
        await noteEntry(d.page).getByRole("button", { name: "Open", exact: true }).click();
        await rowButton(d.page, "Recovery key", "Use").click();
        await d.page.getByLabel("Recovery key", { exact: true }).fill(recoveryKey);
        await d.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
        await declineOffer(d.page);
      }
      await expect(noteEntry(d.page)).toContainText(NOTE, { timeout: 30_000 });
      await expect(whoStep(d.page).locator(".lock-mark")).toBeVisible();
      await noSideways(d.page, `opened, ${size.name}, ${theme}`);
      await d.page.screenshot({ path: join(SHOTS, `locked-open-${theme}-${size.name}.png`) });
    }
    expect(d.errors).toEqual([]);
    await d.context.close();
  });
}

test("App lock at 1 minute covers the page after the time and opens with Face ID", async () => {
  test.setTimeout(150_000);
  const d = holder;
  await openAccountSection(d.page, "Privacy and security");
  const appLock = d.page.getByRole("group", { name: "App lock" });
  await expect(appLock).toBeVisible({ timeout: 30_000 });
  await appLock.getByRole("button", { name: "1 minute", exact: true }).click();
  await expect(appLock.getByRole("button", { name: "1 minute", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(d.page.getByRole("dialog", { name: "VEMI is locked" })).toHaveCount(0);

  // Two minutes on by the page's own clock, then a cold open: past the time, it starts covered.
  await d.page.clock.install({ time: new Date(Date.now() + 2 * 60_000) });
  await d.page.reload();
  const cover = d.page.getByRole("dialog", { name: "VEMI is locked" });
  await expect(cover).toBeVisible({ timeout: 20_000 });
  await d.page.screenshot({ path: join(SHOTS, "locked-applock-desk.png") });
  await cover.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  await expect(cover).toHaveCount(0);

  // Put it back off, so what follows is not covered.
  await nav(d.page).getByRole("button", { name: /^Privacy and security( ›)?$/ }).click();
  await d.page.getByRole("group", { name: "App lock" }).getByRole("button", { name: "Off", exact: true }).click();
  await expect(d.page.getByRole("group", { name: "App lock" }).getByRole("button", { name: "Off", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(d.errors).toEqual([]);
});
