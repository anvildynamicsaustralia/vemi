import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { OPERATOR_EMAIL, PASSWORD, ROOT, startServer } from "./copy.js";

/**
 * The key in a real browser (VEMI-013, crypto). The copy runs at `http://localhost:<port>`, because
 * WebAuthn refuses an IP address as the relying party id (C19). Every page gets a Chromium virtual
 * authenticator over CDP, with the PRF extension unless a test says otherwise, so the real
 * `navigator.credentials` calls, the IndexedDB shelf and the Worker are all exercised, not fakes.
 *
 * One person, several devices, in order: set up with a passkey and prove no request body holds the
 * recovery key; open a second device by each way in; remove one; make a new recovery key; start
 * again; then the section at phone size in both themes.
 */

const SHOTS = join(ROOT, "e2e", "screenshots");
const VAULT = "an e2e vault password";
const NEXT_VAULT = "a second e2e vault password";

interface Copy {
  readonly origin: string;
  readonly api: APIRequestContext;
  readonly stop: () => Promise<void>;
}

async function startCopy(): Promise<Copy> {
  const server = await startServer({ name: "crypto", host: "localhost" });
  const origin = server.origin;
  const api = await request.newContext();
  const claimed = await api.post(`${origin}/auth/claim`, { data: { email: OPERATOR_EMAIL, password: PASSWORD }, headers: { origin } });
  expect(claimed.status()).toBe(200);
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

let copy: Copy;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  copy = await startCopy();
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await copy?.stop();
});

/** A signed-in browser context that also records every request body the page sends. */
interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly sent: Buffer[];
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
  });
  const sent: Buffer[] = [];
  context.on("request", (req) => {
    sent.push(Buffer.from(req.url()));
    const body = req.postDataBuffer();
    if (body !== null) sent.push(body);
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
  return { context, page, sent, errors, cdp, authenticatorId };
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Account sections" });

/** Opens Privacy and security (on a phone the section list comes first). */
async function openPrivacy(page: Page): Promise<void> {
  await page.goto("/account");
  await nav(page).getByRole("button", { name: /^Privacy and security( ›)?$/ }).click();
  await expect(page.getByRole("heading", { name: "Privacy and security", exact: true })).toBeVisible();
}

const deviceRows = (page: Page) => page.locator(".privacy-device-row");
const alertIn = (page: Page) => page.getByRole("alert");
/** The button on the row with this title. */
const rowButton = (page: Page, title: string, button: string) =>
  page.locator(".account-row").filter({ has: page.getByText(title, { exact: true }) }).getByRole("button", { name: button, exact: true });

/** Crockford base32, the first 256 bits of the recovery key's groups. */
function recoveryBytes(key: string): Buffer {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const chars = key.replace(/-/g, "").slice(0, 52);
  let bits = "";
  for (const ch of chars) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= 256; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function expectNeverSent(sent: readonly Buffer[], key: string): void {
  const raw = recoveryBytes(key);
  const compact = key.replace(/-/g, "");
  const needles: Buffer[] = [
    Buffer.from(key), Buffer.from(key.toLowerCase()), Buffer.from(compact), Buffer.from(compact.toLowerCase()),
    Buffer.from(Buffer.from(key).toString("base64")), Buffer.from(Buffer.from(compact).toString("base64")),
    Buffer.from(Buffer.from(key).toString("base64url")), Buffer.from(Buffer.from(compact).toString("base64url")),
    Buffer.from(raw.toString("base64")), Buffer.from(raw.toString("base64url")), Buffer.from(raw.toString("hex")), raw,
    Buffer.from(encodeURIComponent(key)),
  ];
  expect(raw.length).toBe(32);
  for (const body of sent) {
    for (const needle of needles) {
      expect(body.includes(needle), `a request holds the recovery key as ${needle.subarray(0, 6).toString("latin1")}...`).toBe(false);
    }
  }
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
  const notNow = page.getByRole("button", { name: "Not now", exact: true });
  const rows = deviceRows(page).first();
  await Promise.race([
    notNow.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined),
    rows.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await notNow.isVisible()) await notNow.click();
}

let recoveryKey = "";
let passkeyDevice: Device;
let paired: Device;

test("set up with Face ID or a fingerprint; the recovery key is never sent", async ({ browser }) => {
  test.setTimeout(120_000);
  const d = await newDevice(browser);
  passkeyDevice = d;
  await openPrivacy(d.page);
  await expect(d.page.getByText("Locking", { exact: true })).toBeVisible();
  await d.page.getByRole("button", { name: "Set up", exact: true }).click();
  await d.page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  await expect(d.page.locator(".recovery-key-text")).toBeVisible();
  // Done stays off until the last group is typed, and nothing has been saved before then.
  await expect(d.page.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
  recoveryKey = await finishRecovery(d.page);
  await expect(deviceRows(d.page)).toHaveCount(1);
  await expect(deviceRows(d.page).first()).toContainText("This device");
  await expect(d.page.getByText("Set up on this device")).toBeVisible();
  expectNeverSent(d.sent, recoveryKey);

  // A reload opens straight into the rows: this device kept its key (IndexedDB, non-extractable).
  await openPrivacy(d.page);
  await expect(deviceRows(d.page)).toHaveCount(1);
  expectNeverSent(d.sent, recoveryKey);
  expect(d.errors).toEqual([]);
});

test("add a vault password on the first device", async () => {
  const { page } = passkeyDevice;
  await rowButton(page, "Vault password", "Add").click();
  await page.getByLabel("New vault password", { exact: true }).fill(VAULT);
  await page.getByLabel("New vault password again", { exact: true }).fill(VAULT);
  await page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  await expect(rowButton(page, "Vault password", "Change")).toBeVisible();
  expectNeverSent(passkeyDevice.sent, recoveryKey);
  expect(Buffer.concat(passkeyDevice.sent).includes(Buffer.from(VAULT))).toBe(false);
});

test("a second device opens with the synced passkey", async ({ browser }) => {
  test.setTimeout(120_000);
  const second = await newDevice(browser);
  // C20: a synced passkey is the same credential on another device. CDP carries the signing key,
  // maybe not the PRF secret, so when the output differs the first device does it again after
  // forgetting its key, which is what sign-out does (C15).
  const { credentials } = await passkeyDevice.cdp.send("WebAuthn.getCredentials", { authenticatorId: passkeyDevice.authenticatorId });
  expect(credentials.length).toBeGreaterThan(0);
  for (const credential of credentials) {
    await second.cdp.send("WebAuthn.addCredential", { authenticatorId: second.authenticatorId, credential });
  }
  await openPrivacy(second.page);
  await rowButton(second.page, "Face ID or fingerprint", "Use").click();
  const opened = await Promise.race([
    deviceRows(second.page).first().waitFor({ state: "visible", timeout: 20_000 }).then(() => true),
    alertIn(second.page).first().waitFor({ state: "visible", timeout: 20_000 }).then(() => false),
  ]);
  if (opened) {
    test.info().annotations.push({ type: "C20", description: "CDP-copied passkey gave the same PRF output on a second context" });
    await expect(deviceRows(second.page)).toHaveCount(2);
  } else {
    test.info().annotations.push({ type: "C20", description: "CDP-copied passkey gave a different PRF output; fell back to the first device forgetting its key" });
    await passkeyDevice.page.evaluate(() => new Promise<void>((resolve) => {
      const del = indexedDB.deleteDatabase("vemi-keys");
      del.onsuccess = () => resolve();
      del.onerror = () => resolve();
      del.onblocked = () => resolve();
    }));
    await openPrivacy(passkeyDevice.page);
    await rowButton(passkeyDevice.page, "Face ID or fingerprint", "Use").click();
    await expect(deviceRows(passkeyDevice.page).first()).toBeVisible();
    await expect(deviceRows(passkeyDevice.page)).toHaveCount(2);
  }
  await second.context.close();
});

test("a device opens with the vault password", async ({ browser }) => {
  test.setTimeout(120_000);
  const d = await newDevice(browser, { prf: false });
  await openPrivacy(d.page);
  await rowButton(d.page, "Vault password", "Use").click();
  await d.page.getByLabel("Vault password", { exact: true }).fill(VAULT);
  await d.page.getByRole("button", { name: "Use vault password", exact: true }).click();
  await declineOffer(d.page);
  await expect(deviceRows(d.page).first()).toBeVisible();
  await expect(deviceRows(d.page)).toHaveCount(3);
  await d.context.close();
});

test("a device opens with the recovery key", async ({ browser }) => {
  test.setTimeout(120_000);
  const d = await newDevice(browser, { prf: false });
  await openPrivacy(d.page);
  await rowButton(d.page, "Recovery key", "Use").click();
  await d.page.getByLabel("Recovery key", { exact: true }).fill(recoveryKey.toLowerCase());
  await d.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  await declineOffer(d.page);
  await expect(deviceRows(d.page).first()).toBeVisible();
  await expect(deviceRows(d.page)).toHaveCount(4);
  await d.context.close();
});

test("a device opens by the QR link, once the first device allows it", async ({ browser }) => {
  test.setTimeout(180_000);
  const fresh = await newDevice(browser, { prf: false });
  await openPrivacy(fresh.page);
  await fresh.page.getByRole("button", { name: "Show QR", exact: true }).click();
  const linkText = (await fresh.page.locator(".pair-link").innerText()).trim();
  expect(linkText).toContain(`${copy.origin}/account#pair=`);
  await expect(fresh.page.getByRole("img", { name: /QR code/ })).toBeVisible();

  const holder = passkeyDevice.page;
  await holder.goto("about:blank");
  await holder.goto(linkText);
  await expect(holder.getByText("Let a new device open locked things?")).toBeVisible();
  await holder.getByRole("button", { name: "Allow", exact: true }).click();
  await holder.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  await expect(holder.getByText("Let a new device open locked things?")).toHaveCount(0);

  await expect(deviceRows(fresh.page).first()).toBeVisible({ timeout: 30_000 });
  await expect(deviceRows(fresh.page)).toHaveCount(5);
  paired = fresh;
});

test("removing a device makes it ask for a way in again", async () => {
  test.setTimeout(120_000);
  const rowsBefore = 5;
  await expect(deviceRows(paired.page).filter({ hasText: "This device" })).toHaveCount(1);
  // The first device removes the paired one, the newest row, last in the list.
  await openPrivacy(passkeyDevice.page);
  await expect(deviceRows(passkeyDevice.page)).toHaveCount(rowsBefore);
  await deviceRows(passkeyDevice.page).last().getByRole("button", { name: "Remove", exact: true }).click();
  await expect(deviceRows(passkeyDevice.page)).toHaveCount(rowsBefore - 1);

  // The removed device forgets its key on its next open (C10), and asks for a way in.
  await openPrivacy(paired.page);
  await expect(paired.page.getByRole("button", { name: "Show QR", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(deviceRows(paired.page)).toHaveCount(0);
  await paired.context.close();
});

test("a new recovery key replaces the old one", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = passkeyDevice;
  await openPrivacy(page);
  await rowButton(page, "Recovery key", "Make a new one").click();
  await page.getByRole("button", { name: "Face ID or fingerprint", exact: true }).click();
  const next = await finishRecovery(page);
  expect(next).not.toBe(recoveryKey);
  await expect(deviceRows(page).first()).toBeVisible();
  expectNeverSent(passkeyDevice.sent, next);

  const d = await newDevice(browser, { prf: false });
  await openPrivacy(d.page);
  await rowButton(d.page, "Recovery key", "Use").click();
  await d.page.getByLabel("Recovery key", { exact: true }).fill(recoveryKey);
  await d.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  await expect(alertIn(d.page).first()).toBeVisible();
  await expect(deviceRows(d.page)).toHaveCount(0);
  await d.page.getByLabel("Recovery key", { exact: true }).fill(next);
  await d.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  await declineOffer(d.page);
  await expect(deviceRows(d.page).first()).toBeVisible();
  await d.context.close();
  recoveryKey = next;
});

test("start again with a vault password only; the old key is refused, the new one opens", async ({ browser }) => {
  test.setTimeout(180_000);
  const old = recoveryKey;
  const d = await newDevice(browser, { prf: false });
  await openPrivacy(d.page);
  await rowButton(d.page, "I've lost every way in", "Open").click();
  await expect(d.page.getByText("Locked things can't be opened without one of these.")).toBeVisible();
  await d.page.getByRole("button", { name: "Start again with a new key", exact: true }).click();
  await d.page.getByLabel("Sign-in password", { exact: true }).fill("not the password");
  await d.page.getByRole("button", { name: "Start again with a new key", exact: true }).click();
  await expect(alertIn(d.page).first()).toBeVisible();
  await d.page.getByLabel("Sign-in password", { exact: true }).fill(PASSWORD);
  await d.page.getByRole("button", { name: "Start again with a new key", exact: true }).click();

  // No Face ID here: the vault password is the way in.
  await d.page.getByRole("button", { name: "Vault password", exact: true }).click();
  await d.page.getByLabel("Vault password", { exact: true }).fill(NEXT_VAULT);
  await d.page.getByLabel("Vault password again", { exact: true }).fill(NEXT_VAULT);
  await d.page.getByRole("button", { name: "Continue", exact: true }).click();
  const fresh = await finishRecovery(d.page);
  expect(fresh).not.toBe(old);
  await expect(deviceRows(d.page)).toHaveCount(1);
  expectNeverSent(d.sent, fresh);
  expect(Buffer.concat(d.sent).includes(Buffer.from(NEXT_VAULT))).toBe(false);

  const other = await newDevice(browser, { prf: false });
  await openPrivacy(other.page);
  await rowButton(other.page, "Recovery key", "Use").click();
  await other.page.getByLabel("Recovery key", { exact: true }).fill(old);
  await other.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  await expect(alertIn(other.page).first()).toBeVisible();
  await other.page.getByLabel("Recovery key", { exact: true }).fill(fresh);
  await other.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  await declineOffer(other.page);
  await expect(deviceRows(other.page)).toHaveCount(2);
  await other.context.close();
  await d.context.close();
  recoveryKey = fresh;
});

const noSideways = async (page: Page, what: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
};

for (const theme of ["light", "dark"] as const) {
  test(`Privacy and security at phone size, ${theme}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const res = await copy.api.patch(`${copy.origin}/api/appearance`, { data: { theme }, headers: { origin: copy.origin } });
    expect(res.status()).toBeLessThan(300);
    const d = await newDevice(browser, { prf: false, phone: true });
    await openPrivacy(d.page);
    await expect(d.page.locator("html")).toHaveAttribute("data-theme", theme);
    // A device with no key: every way in, drawn at 390 wide.
    await expect(d.page.getByRole("button", { name: "Show QR", exact: true })).toBeVisible();
    await noSideways(d.page, `unlock, ${theme}`);
    await d.page.screenshot({ path: join(SHOTS, `crypto-unlock-${theme}-phone.png`) });

    await rowButton(d.page, "Recovery key", "Use").click();
    await d.page.getByLabel("Recovery key", { exact: true }).fill(recoveryKey);
    await d.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
    await declineOffer(d.page);
    await expect(deviceRows(d.page).first()).toBeVisible();
    await expect(d.page.getByText("Devices", { exact: true })).toBeVisible();
    await noSideways(d.page, `rows, ${theme}`);
    await d.page.screenshot({ path: join(SHOTS, `crypto-rows-${theme}-phone.png`) });
    expect(d.errors).toEqual([]);
    await d.context.close();
  });
}
