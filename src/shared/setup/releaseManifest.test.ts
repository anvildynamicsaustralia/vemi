import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  assetHash,
  assetKey,
  buildManifest,
  checkManifest,
  latestText,
  manifestText,
  migrationOrderProblems,
  notesFor,
  sha256Hex,
  type BundleFiles,
  type ReleaseFile,
  type ReleaseInput,
} from "./releaseManifest.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string): ReleaseFile => ({ path, bytes: enc(text) });

const NOTES = "# Release notes\n\n## 0.2.0\n\nSecond.\n\n## 0.1.0\n\nFirst release.\nTwo lines.\n";

function input(over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    version: "0.1.0",
    issuedAt: "2026-11-25T00:00:00.000Z",
    notesFile: NOTES,
    compatibilityDate: "2026-09-11",
    bindings: [{ name: "STORE", type: "d1" }],
    variables: ["OWNER"],
    worker: file("worker/index.js", "export default {};"),
    client: [file("/index.html", "<html></html>"), file("/assets/app.js", "console.log(1)"), file("/_headers", "/*\n")],
    migrations: [file("0001_a.sql", "CREATE TABLE a (x);"), file("0002_b.sql", "CREATE TABLE b (x);")],
    ...over,
  };
}

function filesOf(i: ReleaseInput): BundleFiles {
  return { worker: i.worker, client: i.client, migrations: i.migrations };
}

describe("the client hash rule", () => {
  it("is SHA-256 of the base64 text plus the extension, and the key is the first 32", async () => {
    const bytes = enc("hello");
    const expected = createHash("sha256").update(`${Buffer.from(bytes).toString("base64")}txt`).digest("hex");
    const hash = await assetHash({ path: "/a/hello.txt", bytes });
    expect(hash).toBe(expected);
    expect(hash).toHaveLength(64);
    expect(assetKey(hash)).toBe(expected.slice(0, 32));
  });

  it("adds nothing for a file with no extension, and uses only the last extension", async () => {
    const bytes = enc("x");
    const plain = createHash("sha256").update(Buffer.from(bytes).toString("base64")).digest("hex");
    expect(await assetHash({ path: "/LICENSE", bytes })).toBe(plain);
    expect(await assetHash({ path: "/dir.d/LICENSE", bytes })).toBe(plain);
    const gz = createHash("sha256").update(`${Buffer.from(bytes).toString("base64")}gz`).digest("hex");
    expect(await assetHash({ path: "/a.tar.gz", bytes })).toBe(gz);
  });

  it("hashes a large file without running out of stack", async () => {
    const big = new Uint8Array(300_000).fill(7);
    const expected = createHash("sha256").update(`${Buffer.from(big).toString("base64")}bin`).digest("hex");
    expect(await assetHash({ path: "/big.bin", bytes: big })).toBe(expected);
  });
});

describe("notesFor", () => {
  it("returns the section for the version only", () => {
    expect(notesFor(NOTES, "0.1.0")).toBe("First release.\nTwo lines.");
    expect(notesFor(NOTES, "0.2.0")).toBe("Second.");
  });

  it("is null when there is no section, or it is empty, or only a longer version matches", () => {
    expect(notesFor(NOTES, "0.3.0")).toBeNull();
    expect(notesFor("## 0.1.0\n\n## 0.0.9\nx\n", "0.1.0")).toBeNull();
    expect(notesFor("## 0.1.10\nx\n", "0.1.1")).toBeNull();
  });
});

describe("migration order", () => {
  it("accepts rising numbers and names the problems otherwise", () => {
    expect(migrationOrderProblems(["0001_a.sql", "0003_c.sql", "0004_d.sql"])).toEqual([]);
    expect(migrationOrderProblems(["0002_b.sql", "0001_a.sql"])).toEqual(["migration 0001_a.sql is out of order"]);
    expect(migrationOrderProblems(["0001_a.sql", "0001_b.sql"])).toEqual(["migration number 0001 is used twice"]);
    expect(migrationOrderProblems(["1_a.sql"])).toEqual(["migration 1_a.sql is not named NNNN_name.sql"]);
  });
});

describe("buildManifest", () => {
  it("lists every file with its size and hash, and takes the version's notes", async () => {
    const i = input();
    const m = await buildManifest(i);
    expect(m.version).toBe("0.1.0");
    expect(m.notes).toBe("First release.\nTwo lines.");
    expect(m.compatibilityDate).toBe("2026-09-11");
    expect(m.bindings).toEqual([{ name: "STORE", type: "d1" }]);
    expect(m.variables).toEqual(["OWNER"]);
    expect(m.worker).toEqual({
      path: "worker/index.js",
      size: 18,
      sha256: createHash("sha256").update("export default {};").digest("hex"),
    });
    expect(m.client.map((c) => c.path)).toEqual(["/_headers", "/assets/app.js", "/index.html"]);
    for (const line of m.client) {
      const source = i.client.find((c) => c.path === line.path)!;
      expect(line.size).toBe(source.bytes.length);
      expect(line.assetHash).toBe(await assetHash(source));
    }
    expect(m.migrations).toEqual([
      { name: "0001_a.sql", sha256: createHash("sha256").update("CREATE TABLE a (x);").digest("hex") },
      { name: "0002_b.sql", sha256: createHash("sha256").update("CREATE TABLE b (x);").digest("hex") },
    ]);
    expect("signature" in m).toBe(false);
    expect(await checkManifest(m, filesOf(i))).toEqual([]);
  });

  it("refuses when the notes have no section for the version", async () => {
    await expect(buildManifest(input({ version: "0.9.0" }))).rejects.toThrow("RELEASE_NOTES.md has no section for 0.9.0");
  });

  it("carries the issue date, and refuses one that is not an ISO UTC time", async () => {
    expect((await buildManifest(input())).issuedAt).toBe("2026-11-25T00:00:00.000Z");
    for (const issuedAt of ["", "yesterday", "2026-11-25", "2026-11-25T00:00:00Z", "2026-13-45T00:00:00.000Z"]) {
      await expect(buildManifest(input({ issuedAt })), issuedAt).rejects.toThrow("issuedAt is not an ISO 8601 UTC time");
    }
  });

  it("refuses migrations out of order", async () => {
    const bad = [file("0002_b.sql", "b"), file("0001_a.sql", "a")];
    await expect(buildManifest(input({ migrations: bad }))).rejects.toThrow("out of order");
  });
});

describe("checkManifest", () => {
  async function made() {
    const i = input();
    return { i, m: await buildManifest(i) };
  }

  it("fails when a client file is added after the manifest", async () => {
    const { i, m } = await made();
    const files = filesOf(i);
    files.client = [...files.client, file("/extra.js", "x")];
    expect(await checkManifest(m, files)).toEqual(["client file /extra.js is not in the manifest"]);
  });

  it("fails when a client file is removed", async () => {
    const { i, m } = await made();
    const files = filesOf(i);
    files.client = files.client.filter((c) => c.path !== "/assets/app.js");
    expect(await checkManifest(m, files)).toEqual(["client file /assets/app.js is listed but missing"]);
  });

  it("fails when a client file changes, even to the same length", async () => {
    const { i, m } = await made();
    const files = filesOf(i);
    files.client = files.client.map((c) => (c.path === "/assets/app.js" ? file(c.path, "console.log(2)") : c));
    expect(await checkManifest(m, files)).toEqual(["client file /assets/app.js has changed since the manifest was written"]);
  });

  it("fails when a client file changes length", async () => {
    const { i, m } = await made();
    const files = filesOf(i);
    files.client = files.client.map((c) => (c.path === "/index.html" ? file(c.path, "<html>more</html>") : c));
    expect(await checkManifest(m, files)).toHaveLength(1);
  });

  it("fails when the Worker changes", async () => {
    const { i, m } = await made();
    const files = { ...filesOf(i), worker: file("worker/index.js", "export default 1;;;;;;") };
    expect(await checkManifest(m, files)).toHaveLength(1);
    const same = { ...filesOf(i), worker: file("worker/index.js", "export default [];") };
    expect(await checkManifest(m, same)).toEqual(["the Worker has changed since the manifest was written"]);
  });

  it("fails when a migration is added, removed or changed", async () => {
    const { i, m } = await made();
    const added = { ...filesOf(i), migrations: [...i.migrations, file("0003_c.sql", "c")] };
    expect(await checkManifest(m, added)).toEqual(["migration 0003_c.sql is not in the manifest"]);
    const removed = { ...filesOf(i), migrations: i.migrations.slice(0, 1) };
    expect(await checkManifest(m, removed)).toEqual(["migration 0002_b.sql is listed but missing"]);
    const changed = { ...filesOf(i), migrations: [i.migrations[0]!, file("0002_b.sql", "CREATE TABLE b (y);")] };
    expect(await checkManifest(m, changed)).toEqual(["migration 0002_b.sql has changed since the manifest was written"]);
  });

  it("fails when the manifest lists migrations out of order", async () => {
    const { i, m } = await made();
    const swapped = { ...m, migrations: [...m.migrations].reverse() };
    expect(await checkManifest(swapped, filesOf(i))).toContain("migration 0001_a.sql is out of order");
  });
});

describe("latest", () => {
  it("holds the version and the hash of the manifest's own text", async () => {
    const m = await buildManifest(input());
    const text = manifestText(m);
    const latest = JSON.parse(await latestText(m.version, text));
    expect(latest).toEqual({ version: "0.1.0", manifestSha256: await sha256Hex(enc(text)) });
  });
});
