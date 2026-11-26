import { describe, expect, it } from "vitest";
import type { BuildBundle } from "../../shared/setup/buildSteps.js";
import { buildManifest, latestText, manifestText, sha256Hex, type ReleaseFile } from "../../shared/setup/releaseManifest.js";
import { handOver, TRIES } from "./handOver.js";
import { lightBundle, loadBundle, loadManifest } from "./loadRelease.js";

const TOKEN = "fake-key-0123456789";
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string): ReleaseFile => ({ path, bytes: enc(text) });

async function bundle(): Promise<BuildBundle> {
  const worker = file("worker/index.js", "export default {};");
  const client = [file("/index.html", "<html></html>"), file("/assets/app.js", "console.log(1)"), file("/get/index.html", "<html>get</html>")];
  const migrations = [file("0001_a.sql", "CREATE TABLE a (x TEXT);")];
  const manifest = await buildManifest({ version: "0.1.0", issuedAt: "2026-11-25T00:00:00.000Z", notesFile: "## 0.1.0\n\nFirst.\n", compatibilityDate: "2026-09-11", bindings: [], variables: [], worker, client, migrations });
  return { manifest, worker, client, migrations };
}

describe("the release, read as static files", () => {
  async function site(corrupt?: string) {
    const b = await bundle();
    const text = manifestText(b.manifest);
    const latest = await latestText("0.1.0", text);
    const files = new Map<string, Uint8Array>([
      ["/release/latest.json", enc(latest)],
      ["/release/0.1.0/manifest.json", enc(text)],
      ["/release/0.1.0/worker/index.js", b.worker.bytes],
      ...b.client.map((f): [string, Uint8Array] => [`/release/0.1.0/client${f.path}`, f.bytes]),
      ...b.migrations.map((f): [string, Uint8Array] => [`/release/0.1.0/migrations/${f.path}`, f.bytes]),
    ]);
    if (corrupt !== undefined) files.set(corrupt, enc("tampered"));
    const asked: string[] = [];
    const get: typeof fetch = async (input) => {
      const path = String(input);
      asked.push(path);
      const body = files.get(path);
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body.slice().buffer as ArrayBuffer);
    };
    return { get, asked, b };
  }

  it("reads the manifest and every file, and holds them to it", async () => {
    const { get, b } = await site();
    const manifest = await loadManifest(get);
    expect(manifest.version).toBe("0.1.0");
    const progress: number[] = [];
    const loaded = await loadBundle(manifest, get, (done) => progress.push(done));
    expect(loaded.client.map((f) => f.path).sort()).toEqual(b.client.map((f) => f.path).sort());
    expect(loaded.migrations.map((f) => f.path)).toEqual(["0001_a.sql"]);
    expect(progress.at(-1)).toBe(1 + b.client.length + 1);
  });

  it("takes only files from its own folder, and calls no app route", async () => {
    const { get, asked } = await site();
    await loadBundle(await loadManifest(get), get);
    for (const path of asked) expect(path.startsWith("/release/")).toBe(true);
  });

  it("refuses a file that is not the one the manifest lists", async () => {
    const { get } = await site("/release/0.1.0/client/assets/app.js");
    await expect(loadBundle(await loadManifest(get), get)).rejects.toThrow(/did not match their list/);
  });

  it("refuses a manifest that is not the one latest.json names", async () => {
    const { get } = await site("/release/0.1.0/manifest.json");
    await expect(loadManifest(get)).rejects.toThrow(/did not match their list/);
  });

  it("says so in a sentence when there is no release", async () => {
    const none: typeof fetch = async () => new Response("no", { status: 404 });
    await expect(loadManifest(none)).rejects.toThrow(/could not be fetched/);
  });

  it("gives the name check a bundle with no files, so a name is checked before anything is fetched", async () => {
    const { b } = await site();
    const light = lightBundle(b.manifest);
    expect(light.client).toEqual([]);
    expect(light.manifest.version).toBe("0.1.0");
    expect(await sha256Hex(light.worker.bytes)).toHaveLength(64);
  });
});

describe("the hand-over", () => {
  const input = { address: "https://mine.sub.workers.dev", code: "code-0123456789", token: TOKEN, keepUpdated: true };
  const noWait = (): Promise<void> => Promise.resolve();

  it("posts the code and the key to the copy's own /setup/claim, with no credentials", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const doFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ claimed: true }), { status: 200 });
    };
    expect(await handOver({ ...input, fetch: doFetch, wait: noWait })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://mine.sub.workers.dev/setup/claim");
    expect(calls[0]?.init.credentials).toBe("omit");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: input.code, token: TOKEN, keepUpdated: true });
  });

  it("sends no key at all when the switch is off", async () => {
    let body = "";
    const doFetch: typeof fetch = async (_url, init) => {
      body = String(init?.body);
      return new Response("{}", { status: 200 });
    };
    await handOver({ ...input, keepUpdated: false, fetch: doFetch, wait: noWait });
    expect(JSON.parse(body)).toEqual({ code: input.code, keepUpdated: false });
    expect(body).not.toContain(TOKEN);
  });

  it("tries again while the new address is not answering, then gives up with a sentence", async () => {
    let tries = 0;
    const down: typeof fetch = () => {
      tries++;
      return Promise.reject(new TypeError("not yet"));
    };
    const result = await handOver({ ...input, fetch: down, wait: noWait });
    expect(tries).toBe(TRIES);
    expect(result).toEqual({ ok: false, reason: "The new copy is not answering yet. Try again in a minute." });
  });

  it("takes a copy that answers on the third try", async () => {
    let tries = 0;
    const slow: typeof fetch = async () => {
      tries++;
      return tries < 3 ? new Response("starting", { status: 404 }) : new Response("{}", { status: 200 });
    };
    expect(await handOver({ ...input, fetch: slow, wait: noWait })).toEqual({ ok: true });
    expect(tries).toBe(3);
  });

  it("stops at a refusal without trying again", async () => {
    let tries = 0;
    const refused: typeof fetch = async () => {
      tries++;
      return new Response("{}", { status: 403 });
    };
    const result = await handOver({ ...input, fetch: refused, wait: noWait });
    expect(tries).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("does not blame an owner when the copy refuses: a wrong code gets the same answer", async () => {
    const refused: typeof fetch = async () => new Response("{}", { status: 403 });
    const result = await handOver({ ...input, fetch: refused, wait: noWait });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toMatch(/owner/i);
  });
});
