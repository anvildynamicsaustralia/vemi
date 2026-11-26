import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { VERSION } from "./version.js";

it("VERSION is the version in package.json", () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
