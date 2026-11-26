import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, publicRootDocs, walk } from "./walk.js";

/**
 * The foundation brief's first check: the watcher is gone, and no route, table or type
 * refers to a host, a snapshot, an agent or an observed state. And its third: no Node
 * server exists anywhere, and nothing needs to be kept alive on any machine.
 *
 * Deleted, not disabled. It is in git history.
 */

const OBSERVATION = /\b(hosts?|snapshots?|agents?|observed|observations?|watcher)\b/i;

const SERVER_PACKAGES = ["fastify", "express", "koa", "better-sqlite3", "@hono/node-server", "tsx", "nodemon", "pm2"];

describe("the observation machinery", () => {
  it("is deleted", () => {
    // the old client folder was deleted with these and rebuilt from the VEMI-003 prototype; its
    // source is held to the same vocabulary below.
    for (const gone of ["watcher", "hub", "deploy"]) {
      expect(existsSync(join(ROOT, gone)), gone).toBe(false);
    }
  });

  it("is not named by any route, table, type or file in the application", () => {
    const files = [
      ...walk("migrations", [".sql"]),
      ...walk("src", [".ts", ".tsx", ".json"]),
      "wrangler.jsonc",
      ...(existsSync(join(ROOT, "docs")) ? walk("docs", [".md"]) : []),
      ...publicRootDocs(),
    ];
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of files) {
      for (const [n, line] of readFileSync(join(ROOT, file), "utf8").split(/\r?\n/).entries()) {
        if (OBSERVATION.test(line)) hits.push(`${file}:${n + 1}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("no server", () => {
  it("depends on nothing that runs a Node server or keeps a process alive", () => {
    const manifests = ["package.json", ...walk("src", ["package.json"])];
    const hits: string[] = [];
    for (const file of manifests) {
      const pkg = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, Record<string, string> | undefined>;
      const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
      for (const bad of SERVER_PACKAGES) if (names.includes(bad)) hits.push(`${file} -> ${bad}`);
    }
    expect(hits).toEqual([]);
  });

  it("listens on no port and schedules nothing on a machine", () => {
    const hits: string[] = [];
    for (const file of walk("src", [".ts"])) {
      if (file.includes(".test.") || file.includes("/testing/")) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      if (/node:http|createServer|\.listen\(|node:child_process/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
    expect(walk(".", [".ps1", ".cmd", ".service"])).toEqual([]);
  });
});
