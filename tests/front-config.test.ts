import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonc } from "./jsonc.js";
import { ROOT } from "./walk.js";

/**
 * The front door is a separate Worker with no state beyond one counter (R4): no D1, no Durable
 * Object, no cron, one KV namespace named RELAY_DAY, no secret in the file.
 */

type Front = {
  name: string;
  main: string;
  workers_dev?: boolean;
  assets: { directory: string; run_worker_first?: string[] };
  observability?: { enabled?: boolean };
  kv_namespaces?: { binding: string; id?: string }[];
  vars?: Record<string, string>;
} & Record<string, unknown>;

const config = readJsonc<Front>("wrangler.front.jsonc");
const text = readFileSync(join(ROOT, "wrangler.front.jsonc"), "utf8");

describe("wrangler.front.jsonc", () => {
  it("is the vemi-front Worker over src/front and the dist/front files, with observability off", () => {
    expect(config.name).toBe("vemi-front");
    expect(config.main).toBe("src/front/index.ts");
    expect(config.assets.directory).toBe("dist/front");
    expect(config.observability?.enabled).toBe(false);
  });

  it("holds no D1 and no Durable Object binding", () => {
    for (const key of ["d1_databases", "durable_objects", "migrations", "triggers", "r2_buckets", "queues", "services", "ai", "send_email"]) {
      expect(config[key], key).toBeUndefined();
    }
    expect(JSON.stringify(config)).not.toMatch(/d1|durable/i);
  });

  it("holds no KV binding other than RELAY_DAY, and no id", () => {
    expect((config.kv_namespaces ?? []).map((k) => k.binding)).toEqual(["RELAY_DAY"]);
    expect(config.kv_namespaces![0]!.id).toBeUndefined();
  });

  it("runs the Worker only for the relay routes, so static files stay free", () => {
    expect(config.assets.run_worker_first).toEqual(["/get/relay", "/get/relay/*"]);
  });

  it("names no secret beyond FRONT_SIGNING_KEY, and carries no vars", () => {
    expect(config.vars).toBeUndefined();
    const names = text.match(/\b[A-Z][A-Z0-9_]*_(?:KEY|SECRET|TOKEN|PASSWORD)\b/g) ?? [];
    expect([...new Set(names)]).toEqual(["FRONT_SIGNING_KEY"]);
  });

  it("holds no account, no domain and no namespace id", () => {
    expect(config.account_id).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
  });
});
