import { describe, expect, it } from "vitest";
import { createBuild, type BuildBundle } from "../shared/setup/buildSteps.js";
import { createCloudflare, SetupError } from "../shared/setup/cloudflareApi.js";
import { createFakeCloudflare } from "../shared/setup/fakeCloudflare.js";
import { claimFor } from "../shared/setup/getFlow.js";
import { buildManifest, type ReleaseFile } from "../shared/setup/releaseManifest.js";
import { createRelayFetch } from "../web/get/relayFetch.js";
import { createRelay, type KeyValue } from "./relay.js";

/**
 * The setup page's own way to Cloudflare (src/web/get/relayFetch.ts) against the real relay in
 * front of the fake Cloudflare: what the page sends is what the relay takes, and a whole copy
 * can be built through the two.
 */

const TOKEN = "fake-key-0123456789";
const ORIGIN = "https://front.example.test";
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string): ReleaseFile => ({ path, bytes: enc(text) });

function memoryKv(): KeyValue & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async (key) => values.get(key) ?? null, put: async (key, value) => void values.set(key, value) };
}

/** The relay in front of the fake, reached the way the page reaches it: by path, from one origin. */
function rig(now: () => Date = () => new Date("2026-11-20T10:00:00Z")) {
  const fake = createFakeCloudflare({ token: TOKEN });
  const day = memoryKv();
  const relay = createRelay({ secret: "relay-test-secret", day, now, fetch: (url, init) => fake.fetch(url, init), origin: ORIGIN });
  const seen: string[] = [];
  const page: typeof fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    seen.push(path);
    const request = new Request(`${ORIGIN}${path}`, { ...init, headers: { ...(init?.headers as Record<string, string>), origin: ORIGIN } });
    if (request.method === "OPTIONS") return relay.preflight(request);
    return path === "/get/relay/start" ? relay.start(request) : relay.forward(request);
  };
  return { fake, day, relay, page, seen };
}

async function bundle(): Promise<BuildBundle> {
  const worker = file("worker/index.js", "export default {};");
  const client = [file("/index.html", "<html></html>"), file("/assets/app.js", "console.log(1)"), file("/get/index.html", "<html>get</html>")];
  const migrations = [file("0001_a.sql", "CREATE TABLE a (x TEXT);")];
  const manifest = await buildManifest({ version: "0.1.0", issuedAt: "2026-11-25T00:00:00.000Z", notesFile: "## 0.1.0\n\nFirst.\n", compatibilityDate: "2026-09-11", bindings: [], variables: [], worker, client, migrations });
  return { manifest, worker, client, migrations };
}

describe("the page's way to Cloudflare, through the relay", () => {
  it("lists the account with the key it was given", async () => {
    const { fake, page } = rig();
    const api = createCloudflare({ fetch: createRelayFetch({ token: TOKEN, fetch: page }).fetch, token: TOKEN });
    expect(await api.listAccounts()).toEqual([{ id: "acct-test", name: "Test account" }]);
    expect(fake.requests.map((r) => r.label)).toContain("accounts.list");
  });

  it("builds a whole copy through it, files and Worker upload included, and the key is on no recorded line", async () => {
    const { fake, page } = rig();
    const api = createCloudflare({ fetch: createRelayFetch({ token: TOKEN, fetch: page }).fetch, token: TOKEN });
    const lines: string[] = [];
    const plan = { api, accountId: "acct-test", name: "mine", from: "https://page.example.test", claim: await claimFor("acct-test", "mine"), bundle: await bundle(), log: (line: string) => lines.push(line) };
    const outcome = await createBuild(plan).run();
    expect(outcome.ok).toBe(true);
    expect([...fake.workers.keys()]).toEqual(["mine"]);
    expect(fake.workers.get("mine")?.workersDev).toBe(true);
    expect(fake.databases.size).toBe(1);
    for (const line of [...lines, ...fake.log]) expect(line).not.toContain(TOKEN);
    expect(JSON.stringify(fake.requests)).not.toContain(TOKEN);
  });

  it("asks for one ticket and reuses it for every call", async () => {
    const { page, seen } = rig();
    const api = createCloudflare({ fetch: createRelayFetch({ token: TOKEN, fetch: page }).fetch, token: TOKEN });
    await api.listAccounts();
    await api.getSubdomain("acct-test");
    expect(seen.filter((p) => p === "/get/relay/start")).toHaveLength(1);
    expect(seen.filter((p) => p === "/get/relay")).toHaveLength(2);
  });

  it("asks again, once, when its ticket has lapsed", async () => {
    let now = new Date("2026-11-20T10:00:00Z");
    const { page, seen } = rig(() => now);
    const api = createCloudflare({ fetch: createRelayFetch({ token: TOKEN, fetch: page }).fetch, token: TOKEN });
    await api.listAccounts();
    now = new Date("2026-11-20T13:00:00Z");
    expect(await api.listAccounts()).toHaveLength(1);
    expect(seen.filter((p) => p === "/get/relay/start")).toHaveLength(2);
  });

  it("says the relay's own sentence when a day's setups are used up", async () => {
    const { day, page } = rig();
    day.values.set("tickets:2026-11-20", "100000");
    const relay = createRelayFetch({ token: TOKEN, fetch: page });
    await expect(relay.ready()).rejects.toThrow("Setup is busy today. Try tomorrow, or use the Deploy button.");
  });

  it("answers a refused key as one sentence that does not hold the key", async () => {
    const { page } = rig();
    const api = createCloudflare({ fetch: createRelayFetch({ token: "wrong-key-0123456789", fetch: page }).fetch, token: "wrong-key-0123456789" });
    const error = await api.listAccounts().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect((error as SetupError).message).toMatch(/^Cloudflare would not list the accounts: /);
    expect((error as SetupError).message).not.toContain("wrong-key");
  });

  it("says so in a sentence when the relay cannot be reached", async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError("offline"));
    await expect(createRelayFetch({ token: TOKEN, fetch: down }).ready()).rejects.toThrow(/could not be reached/);
  });

  it("never sends a call to anything but the relay's two paths", async () => {
    const { page, seen } = rig();
    const api = createCloudflare({ fetch: createRelayFetch({ token: TOKEN, fetch: page }).fetch, token: TOKEN });
    await api.listAccounts();
    expect(new Set(seen)).toEqual(new Set(["/get/relay/start", "/get/relay"]));
  });
});
