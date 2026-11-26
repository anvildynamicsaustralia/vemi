import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { startServer } from "./copy.js";
import { readableCells } from "../src/web/moveLocked.js";

/**
 * Moving into a new copy, in a real browser against real Workers and databases (move-to-cloud).
 *
 * The locked case goes through the door the helper uses: a copy with no owner and a move code
 * (`POST /setup/move`), then the finishing screen on the new copy, opened by the file's own passkey
 * through a Chromium virtual authenticator, as the crypto phase does. An invited account's way out
 * is a file it exports itself: no request leaves its copy for the helper or anyone else.
 *
 * Both copies run at `http://localhost:<port>`: WebAuthn refuses an IP address as the relying
 * party id, and the authenticator's passkey is the same one on both ports.
 */

const OWNER_EMAIL = "owner@example.test";
const OWNER_PASSWORD = "an e2e owner password";
const NEW_EMAIL = "mover@example.test";
const NEW_PASSWORD = "a password for the new copy";
const INVITED_EMAIL = "guest@example.test";
const INVITED_PASSWORD = "an e2e guest password";
const SECRET = "ZEBRANOTE the safe code is 4821";
/** The one origin a copy built by the helper lets read its move answer. */
const HELPER = "https://helper.example.test";
const MOVE_CODE = "e2e-move-code-0123456789abcdef";

interface Copy {
  readonly origin: string;
  readonly api: APIRequestContext;
  readonly stop: () => Promise<void>;
}
type Exported = { tables: Record<string, Record<string, unknown>[]> };

async function startCopy(options: { readonly owner: boolean }): Promise<Copy> {
  const server = await startServer({ name: "move", host: "localhost", vars: (origin, port) => ({ ORIGIN: origin, SESSION_SECRET: `e2e-session-secret-${port}`, ...(options.owner ? { OPERATOR_EMAIL: OWNER_EMAIL } : { SETUP_CLAIM: MOVE_CODE, SETUP_FROM: HELPER }) }) });
  const origin = server.origin;
  const api = await request.newContext();
  if (options.owner) {
    const claimed = await api.post(`${origin}/auth/claim`, { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD }, headers: { origin } });
    expect(claimed.status()).toBe(200);
    await api.patch(`${origin}/api/first-run`, { data: { step: null }, headers: { origin } });
  }
  return {
    origin,
    api,
    stop: async () => {
      await api.dispose();
      await server.stop();
    },
  };
}

let old: Copy;
let fresh: Copy | null = null;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => { test.setTimeout(240_000); old = await startCopy({ owner: true }); });
test.afterAll(async () => { await old?.stop(); await fresh?.stop(); });

async function send<T>(method: "post" | "patch", path: string, data: unknown): Promise<T> {
  const response = await old.api[method](`${old.origin}${path}`, { data, headers: { origin: old.origin } });
  expect(response.status(), path).toBeLessThan(300);
  return (await response.json()) as T;
}

const exportOf = async (copy: Copy, api: APIRequestContext = copy.api): Promise<Exported> =>
  (await (await api.get(`${copy.origin}/api/export`)).json()) as Exported;

const nav = (page: Page) => page.getByRole("navigation", { name: "Account sections" });

async function openAccountSection(page: Page, name: string): Promise<void> {
  await page.goto("/account");
  await nav(page).getByRole("button", { name: new RegExp(`^${name}( ›)?$`) }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

test("a locked note moves through the door, opens by the file's passkey on the new copy, and no table holds its text", async ({ browser }) => {
  test.setTimeout(300_000);
  const venture = await send<{ id: string }>("post", "/api/ventures", { name: "Studio" });
  const project = await send<{ id: string }>("post", "/api/projects", { ventureId: venture.id, name: "Shed" });
  const note = await send<{ id: string }>("post", "/api/notes", { projectId: project.id, body: SECRET });

  // One browser with one virtual authenticator, so the passkey the old copy makes is there for the new copy too.
  const context = await browser.newContext({ baseURL: old.origin, storageState: await old.api.storageState(), acceptDownloads: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctapVersion: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });

  // Lock the note on the old copy: the first lock sets up the key with a passkey and shows the recovery key.
  await page.goto(`/ventures/${venture.id}/projects/${project.id}`);
  const entry = page.locator(".notes-entry").first();
  await expect(entry).toContainText(SECRET);
  await entry.getByRole("button", { name: "Lock", exact: true }).click();
  await page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  const recovery = (await page.locator(".recovery-key-text").innerText()).trim();
  await page.getByLabel("Last group", { exact: true }).fill(recovery.split("-").pop() ?? "");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(entry.locator(".lock-mark")).toBeVisible();
  await expect.poll(async () => (await exportOf(old)).tables["note"]?.find((r) => r["id"] === note.id)?.["body"], { timeout: 20_000 }).toMatch(/^v1\./);

  // Export it, locked content kept locked.
  await openAccountSection(page, "Your data");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await expect(page.getByText("Keep locked content locked in the file?")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  const saved = join(tmpdir(), `vemi-e2e-move-${Date.now()}.json`);
  await (await downloading).saveAs(saved);
  const text = readFileSync(saved, "utf8");
  rmSync(saved, { force: true });
  const file = JSON.parse(text) as Exported;
  expect(readableCells(file, [SECRET])).toEqual([]);
  expect(text).not.toContain("ZEBRA");
  const sealed = file.tables["note"]?.find((r) => r["id"] === note.id)?.["body"];
  expect(sealed).toMatch(/^v1\./);

  // The new copy has no owner. The move code is the copy's own; the door makes the owner and puts the rows in.
  fresh = await startCopy({ owner: false });
  const moved = await fresh.api.post(`${fresh.origin}/setup/move`, {
    data: { code: MOVE_CODE, email: NEW_EMAIL, password: NEW_PASSWORD, document: file },
    headers: { origin: HELPER },
  });
  expect(moved.status()).toBe(200);
  const answer = (await moved.json()) as { counts: Record<string, number>; ids: Record<string, string>; handOver: string; recoveryCode: string; locked: { from: string; to: string }[] };
  expect(answer.counts["note"]).toBe(1);
  const newId = answer.ids[note.id];
  expect(newId).toBeDefined();
  expect(newId).not.toBe(note.id);
  expect(answer.locked.some((l) => l.from === note.id && l.to === newId)).toBe(true);

  // The hand-over signs the person in and lands on the finishing screen; the file is chosen again here.
  await page.goto(`${fresh.origin}/auth/move-in?t=${encodeURIComponent(answer.handOver)}&finish=1`);
  await page.waitForURL((url) => url.origin === fresh?.origin && url.pathname === "/", { timeout: 30_000 });
  await page.getByLabel("Your export file").setInputFiles({ name: "vemi-export.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(page.getByText("Finishing your locked notes").first()).toBeVisible();
  await page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  await expect(page.getByText("Your passkey stays with this device.", { exact: false })).toBeVisible({ timeout: 60_000 });

  // The envelope now belongs to its new id, and no table of the new copy holds the readable text.
  const mine = await exportOf(fresh, context.request);
  const finished = mine.tables["note"]?.find((r) => r["id"] === newId)?.["body"];
  expect(finished).toMatch(/^v1\./);
  expect(finished).not.toBe(sealed);
  expect(readableCells(mine, [SECRET])).toEqual([]);
  expect(JSON.stringify(mine)).not.toContain("ZEBRA");
  expect(errors).toEqual([]);
  await context.close();
});

test("an invited account moves out by a file, and no request leaves its copy for the helper", async ({ browser }) => {
  test.setTimeout(150_000);
  const invite = await send<{ link: string }>("post", "/auth/invite", { email: INVITED_EMAIL });
  const token = invite.link.slice(invite.link.indexOf("#") + 1);
  const guest = await request.newContext();
  const accepted = await guest.post(`${old.origin}/auth/invite/accept`, { data: { token, password: INVITED_PASSWORD }, headers: { origin: old.origin } });
  expect(accepted.status()).toBe(200);

  const context = await browser.newContext({ baseURL: old.origin, storageState: await guest.storageState(), acceptDownloads: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  const seen: string[] = [];
  context.on("request", (req) => { seen.push(req.url()); });
  await page.goto("/account");
  await page.getByRole("button", { name: "Skip" }).click({ timeout: 3000 }).catch(() => undefined);
  await nav(page).getByRole("button", { name: /^Your data( ›)?$/ }).click();
  await expect(page.getByText("Want your own VEMI?")).toBeVisible();
  const get = page.getByRole("link", { name: "Get my own VEMI" });
  await expect(get).toHaveAttribute("href", "/get/?from=old");
  // The card never names who runs the copy.
  await expect(page.locator(".account-row", { hasText: "Want your own VEMI?" })).not.toContainText(OWNER_EMAIL);

  // Making the file is the person's own act, on their device. Nothing is sent for the helper.
  const downloading = page.waitForEvent("download");
  await page.locator(".account-row", { hasText: "Want your own VEMI?" }).getByRole("button", { name: "Export" }).click();
  expect((await downloading).suggestedFilename()).toMatch(/\.json$/);
  await page.waitForLoadState("networkidle");

  const hosts = new Set(seen.filter((u) => /^https?:/.test(u)).map((u) => new URL(u).host));
  expect([...hosts]).toEqual([new URL(old.origin).host]);
  expect(seen.filter((u) => new URL(u).pathname.startsWith("/get"))).toEqual([]);
  expect(seen.filter((u) => u.includes("/setup/"))).toEqual([]);
  await guest.dispose();
  await context.close();
});
