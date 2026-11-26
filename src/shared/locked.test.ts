import { describe, expect, it } from "vitest";
import { LOCKABLE, isSealed, lockBinding, sealedMax } from "./locked.js";
import { seal } from "./crypto/index.js";

const REF = "AAAAAAAAAAA";
const IV = "A".repeat(16);
const DATA = "A".repeat(22);
const ENV = `v1.${REF}.${IV}.${DATA}`;

const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

describe("LOCKABLE", () => {
  it("names the lockable fields", () => {
    expect(LOCKABLE.projects).toEqual(["description", "whoFor", "doneLooks", "openQuestions"]);
    expect(LOCKABLE.tasks).toEqual(["body"]);
    expect(LOCKABLE.notes).toEqual(["body"]);
  });
});

describe("isSealed", () => {
  it("is true for a whole envelope", () => {
    expect(isSealed(ENV)).toBe(true);
  });
  it("is false for ordinary text", () => {
    expect(isSealed("")).toBe(false);
    expect(isSealed("hello")).toBe(false);
    expect(isSealed("v1.2 beta")).toBe(false);
    expect(isSealed("v1.2")).toBe(false);
  });
  it("is false for an envelope with a space, a fourth dot, a newline or other text around it", () => {
    expect(isSealed(`${ENV} `)).toBe(false);
    expect(isSealed(` ${ENV}`)).toBe(false);
    expect(isSealed(`${ENV}\n`)).toBe(false);
    expect(isSealed(`v1.${REF}.${IV}.${DATA.slice(0, 10)} ${DATA.slice(10)}`)).toBe(false);
    expect(isSealed(`${ENV}.${DATA}`)).toBe(false);
    expect(isSealed(`note: ${ENV}`)).toBe(false);
  });
  it("is false for another version or wrong part sizes", () => {
    expect(isSealed(`v2.${REF}.${IV}.${DATA}`)).toBe(false);
    expect(isSealed(`v1.${REF}A.${IV}.${DATA}`)).toBe(false);
    expect(isSealed(`v1.${REF}.${IV}.${DATA.slice(1)}`)).toBe(false);
  });
  it("is true for a real sealed value", async () => {
    const env = await seal(await newKey(), REF, "x", { record: "r", field: "notes.body" });
    expect(isSealed(env)).toBe(true);
  });
});

describe("sealedMax", () => {
  it("is above the plain limit", () => {
    expect(sealedMax(500)).toBeGreaterThan(500);
  });
  it("holds a real envelope of the longest plain text, even all three-byte characters", async () => {
    const key = await newKey();
    const cases: [string, number][] = [
      ["€".repeat(500), 500],
      ["a".repeat(4000), 4000],
      ["\u{1F600}".repeat(1000), 2000],
      ["", 10],
    ];
    for (const [plain, max] of cases) {
      const env = await seal(key, REF, plain, { record: "r", field: "notes.body" });
      expect(env.length).toBeLessThanOrEqual(sealedMax(max));
    }
  });
  it("grows with the limit", () => {
    expect(sealedMax(4000)).toBeGreaterThan(sealedMax(2000));
  });
});

describe("lockBinding", () => {
  it("binds a row id and the kind and field", () => {
    expect(lockBinding("notes", "n1", "body")).toEqual({ record: "n1", field: "notes.body" });
    expect(lockBinding("projects", "p1", "whoFor")).toEqual({ record: "p1", field: "projects.whoFor" });
    expect(lockBinding("tasks", "t1", "body")).toEqual({ record: "t1", field: "tasks.body" });
  });
  it("differs between fields of one row and between kinds", () => {
    expect(lockBinding("projects", "p", "whoFor")).not.toEqual(lockBinding("projects", "p", "doneLooks"));
    expect(lockBinding("tasks", "x", "body")).not.toEqual(lockBinding("notes", "x", "body"));
  });
});
