import { describe, expect, it } from "vitest";
import { UpdateCallError, updateApi } from "./updateApi.js";

const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("updateApi", () => {
  it("reads the offer and whether this person may update", async () => {
    const seen: string[] = [];
    const api = updateApi((async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ current: "0.1.0", offer: { version: "0.2.0", notes: "<b>Faster</b>" }, canUpdate: true, auto: false, back: false }));
    }) as unknown as typeof fetch);
    expect(await api.report()).toEqual({ current: "0.1.0", offer: { version: "0.2.0", notes: "<b>Faster</b>" }, canUpdate: true });
    expect(seen).toEqual(["GET /api/update"]);
  });

  it("reads no offer as null", async () => {
    expect((await updateApi(reply(200, { current: "0.1.0", offer: null, canUpdate: false })).report()).offer).toBeNull();
  });

  it("posts start and step to the real routes", async () => {
    const seen: string[] = [];
    const api = updateApi((async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ step: "files", done: false, remaining: 3, progress: 0 }));
    }) as unknown as typeof fetch);
    expect(await api.start()).toEqual({ step: "files", done: false, remaining: 3 });
    await api.step();
    expect(seen).toEqual(["POST /api/update/start", "POST /api/update/step"]);
  });

  it("carries the Worker's sentence and the step it stopped at", async () => {
    const e = await updateApi(reply(502, { error: "Cloudflare did not answer.", step: "data" })).step().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpdateCallError);
    expect(e).toMatchObject({ status: 502, message: "Cloudflare did not answer.", step: "data" });
  });

  it("says so when nothing answers or the answer is unreadable", async () => {
    const down = updateApi((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch);
    await expect(down.step()).rejects.toMatchObject({ status: 0 });
    await expect(updateApi(reply(200, { nope: 1 })).step()).rejects.toMatchObject({ status: 0 });
  });
});
