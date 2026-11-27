import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script with JSDoc, no declaration file
import { keyNames, plan } from "./dev.mjs";

const example = readFileSync(join(import.meta.dirname, "..", ".dev.vars.example"), "utf8");

describe("dev", () => {
  it("knows every name in .dev.vars.example, plus ORIGIN and OPERATOR_EMAIL", () => {
    const names: string[] = keyNames(example);
    for (const n of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "VAPID_PUBLIC", "VAPID_PRIVATE", "ORIGIN", "OPERATOR_EMAIL"]) expect(names).toContain(n);
  });

  it("reads .dev.vars as before when the environment holds none of the keys", () => {
    const run = plan(keyNames(example), { PATH: "/bin", GOOGLE_CLIENT_ID: "" }, true, ["--port", "9000"]);
    expect(run.source).toBe(".dev.vars");
    expect(run.args).toEqual(["dev", "--port", "9000"]);
    expect(run.env).toEqual({});
  });

  it("starts with no keys when there is neither", () => {
    expect(plan(keyNames(example), {}, false, []).source).toBe("none");
  });

  it("takes the keys from the environment, as infisical run sets them, and skips .dev.vars", () => {
    const run = plan(keyNames(example), { GOOGLE_CLIENT_ID: "x", ORIGIN: "http://localhost:5173" }, true, []);
    expect(run.source).toBe("environment");
    expect(run.found).toEqual(["GOOGLE_CLIENT_ID", "ORIGIN"]);
    expect(run.args).toEqual(["dev", "--env-file", ".dev.vars.example"]);
    expect(run.env).toEqual({ CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" });
  });
});
