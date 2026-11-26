import { describe, expect, it } from "vitest";
import { SetupError, createCloudflare } from "./cloudflareApi.js";
import { createFakeCloudflare } from "./fakeCloudflare.js";

const TOKEN = "tok-test-1";

function setup() {
  const fake = createFakeCloudflare({ token: TOKEN });
  return { fake, api: createCloudflare({ fetch: fake.fetch, token: TOKEN }) };
}

async function refusal(run: () => Promise<unknown>): Promise<SetupError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SetupError);
    return error as SetupError;
  }
  throw new Error("expected a refusal");
}

describe("the Cloudflare client", () => {
  it("checks the key and lists the accounts", async () => {
    const { api } = setup();
    await api.verifyToken();
    expect(await api.listAccounts()).toEqual([{ id: "acct-test", name: "Test account" }]);
  });

  it("reads an absent subdomain as null and makes one", async () => {
    const { api } = setup();
    const empty = createCloudflare({ fetch: createFakeCloudflare({ token: TOKEN, subdomain: null }).fetch, token: TOKEN });
    expect(await empty.getSubdomain("acct-test")).toBeNull();
    expect(await empty.setSubdomain("acct-test", "mine")).toBe("mine");
    expect(await api.getSubdomain("acct-test")).toBe("test-sub");
  });

  it("makes and finds a database, and answers the last statement's rows", async () => {
    const { api } = setup();
    expect(await api.findDatabase("acct-test", "vemi")).toBeNull();
    const made = await api.createDatabase("acct-test", "vemi");
    expect(await api.findDatabase("acct-test", "vemi")).toEqual(made);
    await api.query("acct-test", made.id, "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER);");
    expect(await api.query("acct-test", made.id, "SELECT name FROM d1_migrations ORDER BY id;")).toEqual([]);
  });

  it("refuses in one plain sentence, with no key in it", async () => {
    const { api } = setup();
    const wrong = createCloudflare({ fetch: createFakeCloudflare({ token: TOKEN }).fetch, token: "wrong-key" });
    const error = await refusal(() => wrong.verifyToken());
    expect(error.message).toBe("Cloudflare would not check the key: the key was refused, or it lacks a permission this step needs.");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("wrong-key");
    expect((await refusal(() => api.createDatabase("other-account", "x"))).status).toBe(403);
  });

  it("cuts the key out of what Cloudflare says back", async () => {
    const { fake, api } = setup();
    fake.failOnce("database.create", 400, `name ${TOKEN} is not allowed.\nTry another`);
    const error = await refusal(() => api.createDatabase("acct-test", "vemi"));
    expect(error.message).toBe("Cloudflare would not make the database: name is not allowed. Try another.");
    expect(error.message).not.toContain(TOKEN);
  });

  it("says so when Cloudflare cannot be reached", async () => {
    const api = createCloudflare({
      fetch: async () => {
        throw new TypeError(`network down for ${TOKEN}`);
      },
      token: TOKEN,
    });
    const error = await refusal(() => api.verifyToken());
    expect(error.message).toBe("Cloudflare could not be reached to check the key.");
    expect(error.message).not.toContain(TOKEN);
  });

  it("sends the key only as an authorization header, never in the address", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fake = createFakeCloudflare({ token: TOKEN });
    const api = createCloudflare({
      fetch: (url, init) => {
        seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
        return fake.fetch(url, init);
      },
      token: TOKEN,
    });
    await api.verifyToken();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.url).not.toContain(TOKEN);
  });
});

describe("the calls an update makes", () => {
  const ACCOUNT = "acct-test";
  const SECRET = { name: "SETUP_CLAIM", type: "secret_text" };
  const OWNER = { name: "OWNER", type: "plain_text", text: "x" };

  async function completedAssets(fake: ReturnType<typeof createFakeCloudflare>, api: ReturnType<typeof createCloudflare>, name: string, hashes: string[]) {
    const manifest = Object.fromEntries(hashes.map((hash) => [`/${hash}.js`, { hash, size: 1 }]));
    const session = await api.startAssets(ACCOUNT, name, manifest);
    let jwt: string | null = session.jwt;
    for (const bucket of session.buckets) {
      jwt = await api.uploadAssets(ACCOUNT, session.jwt, bucket.map((hash) => ({ hash, contentType: "text/javascript", base64: "AA==" })));
    }
    expect(jwt).not.toBeNull();
    expect(fake.held.size).toBeGreaterThan(0);
    return jwt as string;
  }

  it("reads the running version, and null for a Worker that is not there", async () => {
    const { fake, api } = setup();
    expect(await api.getDeployment(ACCOUNT, "vemi")).toBeNull();
    fake.seedWorker("vemi", ["vemi:0.1.0"]);
    const first = fake.versions.get("vemi")![0]!;
    expect(await api.getDeployment(ACCOUNT, "vemi")).toEqual({ id: fake.deployments.get("vemi")![0]!.id, versionId: first.id });
  });

  it("refuses a deployment split between versions", async () => {
    const { fake, api } = setup();
    fake.seedWorker("vemi", []);
    fake.deployments.get("vemi")![0]!.versions = [
      { version_id: "a", percentage: 50 },
      { version_id: "b", percentage: 50 },
    ];
    const error = await refusal(() => api.getDeployment(ACCOUNT, "vemi"));
    expect(error.message).toBe("Cloudflare would not read the running version: it is split between versions.");
  });

  it("lists versions newest first and leaves out an expired one", async () => {
    const { fake, api } = setup();
    fake.seedWorker("vemi", ["vemi:0.1.0"]);
    await api.uploadWorker(ACCOUNT, "vemi", { metadata: { main_module: "index.js", tags: ["vemi:0.2.0"] }, moduleName: "index.js", module: "two" });
    await api.uploadWorker(ACCOUNT, "vemi", { metadata: { main_module: "index.js", tags: ["vemi:0.3.0"] }, moduleName: "index.js", module: "three" });
    const all = await api.listVersions(ACCOUNT, "vemi");
    expect(all.map((v) => v.number)).toEqual([3, 2, 1]);
    fake.expireVersion(all[2]!.id);
    expect((await api.listVersions(ACCOUNT, "vemi")).map((v) => v.number)).toEqual([3, 2]);
    await refusal(() => api.listVersions(ACCOUNT, "nothing"));
  });

  it("answers the new version's ID from an upload and deploys it", async () => {
    const { fake, api } = setup();
    fake.seedWorker("vemi", ["vemi:0.1.0"]);
    const id = await api.uploadWorker(ACCOUNT, "vemi", { metadata: { main_module: "index.js", tags: ["vemi:0.2.0"] }, moduleName: "index.js", module: "two" });
    expect(id).not.toBeNull();
    expect((await api.getDeployment(ACCOUNT, "vemi"))!.versionId).toBe(id);
    expect(await api.getWorkerTags(ACCOUNT, "vemi")).toEqual(["vemi:0.2.0"]);
  });

  it("keeps the bindings of a named type and loses the rest", async () => {
    const { fake, api } = setup();
    fake.seedWorker("vemi", ["vemi:0.1.0"], [SECRET, { name: "VAPID", type: "secret_text" }, OWNER]);
    await api.uploadWorker(ACCOUNT, "vemi", {
      metadata: { main_module: "index.js", bindings: [{ name: "DB", type: "d1" }] },
      moduleName: "index.js",
      module: "two",
      keepBindings: ["secret_text"],
    });
    expect(fake.workers.get("vemi")!.bindings.map((b) => b.name).sort()).toEqual(["DB", "SETUP_CLAIM", "VAPID"]);
    expect(fake.workers.get("vemi")!.metadata["keep_bindings"]).toEqual(["secret_text"]);
    await api.uploadWorker(ACCOUNT, "vemi", { metadata: { main_module: "index.js", bindings: [] }, moduleName: "index.js", module: "three" });
    expect(fake.workers.get("vemi")!.bindings).toEqual([]);
  });

  it("deploys an old version, with its own files, and keeps the schedule", async () => {
    const { fake, api } = setup();
    fake.seedWorker("vemi", ["vemi:0.1.0"]);
    await api.setSchedules(ACCOUNT, "vemi", ["* * * * *"]);
    const oldId = fake.versions.get("vemi")![0]!.id;
    const jwt = await completedAssets(fake, api, "vemi", ["aaaa", "bbbb", "cccc"]);
    await api.uploadWorker(ACCOUNT, "vemi", { metadata: { main_module: "index.js", tags: ["vemi:0.2.0"], assets: { jwt } }, moduleName: "index.js", module: "two" });
    expect(fake.servedAssets("vemi")).toEqual(["aaaa", "bbbb", "cccc"]);
    const done = await api.deployVersion(ACCOUNT, "vemi", oldId);
    expect(done.versionId).toBe(oldId);
    expect((await api.getDeployment(ACCOUNT, "vemi"))!.versionId).toBe(oldId);
    expect(await api.getWorkerTags(ACCOUNT, "vemi")).toEqual(["vemi:0.1.0"]);
    expect(fake.servedAssets("vemi")).toEqual([]);
    expect(await api.getSchedules(ACCOUNT, "vemi")).toEqual(["* * * * *"]);
    expect(fake.deployments.get("vemi")![0]!.forced).toBe(false);
    await api.deployVersion(ACCOUNT, "vemi", oldId, { force: true });
    expect(fake.deployments.get("vemi")![0]!.forced).toBe(true);
  });

  it("refuses to deploy a version that is not kept", async () => {
    const { fake, api } = setup();
    fake.seedWorker("vemi", []);
    const id = fake.versions.get("vemi")![0]!.id;
    fake.expireVersion(id);
    const error = await refusal(() => api.deployVersion(ACCOUNT, "vemi", id));
    expect(error.status).toBe(404);
    expect(error.message).toBe("Cloudflare would not switch to that version: Cloudflare could not find it.");
  });

  it("reads a bookmark that moves when the data does", async () => {
    const { fake, api } = setup();
    const db = fake.seedDatabase("vemi", []);
    const before = await api.getBookmark(ACCOUNT, db.id);
    await api.query(ACCOUNT, db.id, "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER);");
    await api.query(ACCOUNT, db.id, "INSERT INTO d1_migrations (name) VALUES ('0001_a.sql');");
    expect(await api.getBookmark(ACCOUNT, db.id)).not.toBe(before);
    await refusal(() => api.getBookmark(ACCOUNT, "no-such-database"));
  });

  it("fails each new call on demand, counts every call, and never holds the key", async () => {
    const { fake, api } = setup();
    fake.seedWorker("vemi", []);
    const db = fake.seedDatabase("vemi", []);
    const version = fake.versions.get("vemi")![0]!.id;
    const calls: [string, () => Promise<unknown>][] = [
      ["deployment.get", () => api.getDeployment(ACCOUNT, "vemi")],
      ["versions.list", () => api.listVersions(ACCOUNT, "vemi")],
      ["deployment.create", () => api.deployVersion(ACCOUNT, "vemi", version)],
      ["bookmark.get", () => api.getBookmark(ACCOUNT, db.id)],
      ["worker.upload", () => api.uploadWorker(ACCOUNT, "vemi", { metadata: { main_module: "index.js" }, moduleName: "index.js", module: "x", keepBindings: ["secret_text"] })],
    ];
    for (const [label, run] of calls) {
      fake.failOnce(label, 400, `${TOKEN} is not allowed`);
      const before = fake.count(label);
      const error = await refusal(run);
      expect(error.message).not.toContain(TOKEN);
      expect(error.message.endsWith(".")).toBe(true);
      expect(error.message.split("\n")).toHaveLength(1);
      expect(fake.count(label)).toBe(before + 1);
      await run();
      expect(fake.count(label)).toBe(before + 2);
    }
    expect(fake.log.join("\n")).not.toContain(TOKEN);
    expect(fake.count()).toBe(fake.requests.length);
  });

  it("says a refused key is refused, on every new call, without the key", async () => {
    const { fake } = setup();
    fake.seedWorker("vemi", []);
    const wrong = createCloudflare({ fetch: fake.fetch, token: "wrong-key" });
    for (const run of [() => wrong.getDeployment(ACCOUNT, "vemi"), () => wrong.listVersions(ACCOUNT, "vemi"), () => wrong.deployVersion(ACCOUNT, "vemi", "v"), () => wrong.getBookmark(ACCOUNT, "d")]) {
      const error = await refusal(run);
      expect(error.status).toBe(401);
      expect(error.message).toContain("the key was refused");
      expect(error.message).not.toContain("wrong-key");
    }
  });

  describe("answers that are not what Cloudflare usually sends", () => {
    const answering = (status: number, body: string) =>
      createCloudflare({ fetch: async () => new Response(body, { status, headers: { "content-type": "text/html" } }), token: TOKEN });

    it("says an unreadable 200 could not be read, and not that Cloudflare said no", async () => {
      const error = await refusal(() => answering(200, "<html>Sign in to the airport wifi</html>").verifyToken());
      expect(error.message).toContain("could not be read");
      expect(error.message).not.toContain("said no");
    });

    it("turns a 200 with a missing result into a refusal, never a TypeError", async () => {
      const api = answering(200, JSON.stringify({ success: true }));
      for (const run of [
        () => api.createDatabase("a", "vemi"),
        () => api.setSubdomain("a", "x"),
        () => api.startAssets("a", "vemi", {}),
        () => api.deployVersion("a", "vemi", "v1"),
      ]) {
        const error = await refusal(run);
        expect(error.message).toContain("could not read");
      }
    });

    it("tells a person to wait after a 429 and to try again after a 5xx", async () => {
      expect((await refusal(() => answering(429, "{}").verifyToken())).message).toContain("wait a minute");
      expect((await refusal(() => answering(503, "oops").verifyToken())).message).toContain("try again");
    });
  });
});
