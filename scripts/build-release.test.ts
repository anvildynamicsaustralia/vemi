import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { checkManifest, type BundleFiles, type ReleaseManifest } from "../src/shared/setup/releaseManifest.js";
// @ts-expect-error the script is plain JavaScript
import { buildRelease } from "./build-release.mjs";

const SCAN = resolve(import.meta.dirname, "release-scan.sh");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

/** A small project tree with a finished build, and nothing else. */
function fixture(over: { notes?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "vemi-release-"));
  roots.push(root);
  put(root, "package.json", JSON.stringify({ name: "x", version: "1.2.3" }));
  put(root, "RELEASE_NOTES.md", over.notes ?? "# Notes\n\n## 1.2.3\n\nWhat changed.\n");
  put(
    root,
    "wrangler.jsonc",
    [
      "{",
      '  // a comment',
      '  "compatibility_date": "2026-09-11",',
      '  "assets": { "directory": "dist/web" },',
      '  "d1_databases": [{ "binding": "STORE", "database_name": "x" }],',
      '  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },',
      '  "vars": { "OWNER": "owner", "TIME_ZONE": "UTC" }',
      "}",
    ].join("\n"),
  );
  put(root, "dist/worker/index.js", "export default { fetch() {} };\n");
  put(root, "dist/worker/index.js.map", "{}");
  put(root, "dist/web/index.html", "<!doctype html>");
  put(root, "dist/web/assets/app.js", "console.log(1);");
  put(root, "migrations/0001_first.sql", "CREATE TABLE a (id TEXT);\n");
  put(root, "migrations/0002_second.sql", "CREATE TABLE b (id TEXT);\n");
  return root;
}

function listed(dir: string): string[] {
  const out: string[] = [];
  const visit = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  visit(dir);
  return out.sort();
}

/** The bundle as it is on disk now, read the way a copy would read it. */
function onDisk(dir: string, manifest: ReleaseManifest): BundleFiles {
  const bytes = (path: string) => new Uint8Array(readFileSync(join(dir, path)));
  const under = (prefix: string) => listed(dir).filter((p) => p.startsWith(`${prefix}/`));
  return {
    worker: { path: manifest.worker.path, bytes: bytes(manifest.worker.path) },
    client: under("client").map((p) => ({ path: p.slice("client".length), bytes: bytes(p) })),
    migrations: under("migrations").map((p) => ({ path: p.slice("migrations/".length), bytes: bytes(p) })),
  };
}

describe("build-release", () => {
  it("writes the Worker, the client, the migrations, the manifest and latest.json", async () => {
    const root = fixture();
    const { dir, manifest } = await buildRelease(root);
    expect(dir).toBe(join(root, "dist", "release", "1.2.3"));
    expect(listed(dir)).toEqual([
      "client/assets/app.js",
      "client/index.html",
      "manifest.json",
      "migrations/0001_first.sql",
      "migrations/0002_second.sql",
      "worker/index.js",
    ]);

    const written = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(written).toEqual(manifest);
    expect(written.version).toBe("1.2.3");
    expect(written.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(written.notes).toBe("What changed.");
    expect(written.compatibilityDate).toBe("2026-09-11");
    expect(written.bindings).toEqual([
      { name: "STORE", type: "d1" },
      { name: "ROOM", type: "durable_object_namespace" },
      { name: "ASSETS", type: "assets" },
    ]);
    expect(written.variables).toEqual(["OWNER", "TIME_ZONE"]);
    expect(written.client.map((c: { path: string }) => c.path)).toEqual(["/assets/app.js", "/index.html"]);
    expect(written.migrations.map((m: { name: string }) => m.name)).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect("signature" in written).toBe(false);

    const latest = JSON.parse(readFileSync(join(root, "dist", "release", "latest.json"), "utf8"));
    expect(latest.version).toBe("1.2.3");
    const { createHash } = await import("node:crypto");
    expect(latest.manifestSha256).toBe(createHash("sha256").update(readFileSync(join(dir, "manifest.json"))).digest("hex"));

    expect(await checkManifest(manifest, onDisk(dir, manifest))).toEqual([]);
  });

  it("fails the check when a file is added, removed or changed after the manifest is written", async () => {
    const root = fixture();
    const { dir, manifest } = await buildRelease(root);

    put(dir, "client/extra.js", "x");
    expect(await checkManifest(manifest, onDisk(dir, manifest))).toEqual(["client file /extra.js is not in the manifest"]);
    rmSync(join(dir, "client/extra.js"));

    writeFileSync(join(dir, "client/index.html"), "<!doctype html>!");
    expect((await checkManifest(manifest, onDisk(dir, manifest)))[0]).toContain("/index.html");
    writeFileSync(join(dir, "client/index.html"), "<!doctype html>");

    rmSync(join(dir, "client/assets/app.js"));
    expect(await checkManifest(manifest, onDisk(dir, manifest))).toEqual(["client file /assets/app.js is listed but missing"]);
  });

  it("refuses when RELEASE_NOTES.md has no section for the version", async () => {
    const root = fixture({ notes: "# Notes\n\n## 9.9.9\n\nElsewhere.\n" });
    await expect(buildRelease(root)).rejects.toThrow("RELEASE_NOTES.md has no section for 1.2.3");
  });

  it("refuses a version that is not a plain version number, before it empties any folder", async () => {
    for (const version of ["../../elsewhere", "..", "1.2", "v1.2.3", "1.2.3/../x", ""]) {
      const root = fixture();
      put(root, "package.json", JSON.stringify({ name: "x", version }));
      put(root, "dist/keep-me.txt", "kept");
      await expect(buildRelease(root), version).rejects.toThrow("not a plain version number");
      expect(readFileSync(join(root, "dist", "keep-me.txt"), "utf8")).toBe("kept");
    }
  });

  it("refuses when the build has not run", async () => {
    const root = fixture();
    rmSync(join(root, "dist", "web"), { recursive: true });
    await expect(buildRelease(root)).rejects.toThrow("dist/web is missing; run the build first");
  });

  it("refuses migrations that do not rise", async () => {
    const root = fixture();
    put(root, "migrations/0002_other.sql", "CREATE TABLE c (id TEXT);\n");
    await expect(buildRelease(root)).rejects.toThrow("migration number 0002 is used twice");
  });

  it("leaves nothing the release scan would stop", async () => {
    const root = fixture();
    const { dir } = await buildRelease(root);
    const r = spawnSync("bash", [SCAN, join(root, "dist", "release")], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("release scan clean");
    expect(r.status).toBe(0);
    expect(dir).toContain("release");
  });

  it("runs again over an old bundle of the same version", async () => {
    const root = fixture();
    await buildRelease(root);
    put(root, "dist/web/assets/app.js", "console.log(2);");
    const { dir, manifest } = await buildRelease(root);
    expect(await checkManifest(manifest, onDisk(dir, manifest))).toEqual([]);
  });
});
